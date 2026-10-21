import { randomUUID } from "node:crypto";
import type { StudioClient, PlaybackStatus, Transport } from "./protocol.js";
import type { ProgramRoute, RoutingOptions } from "./program-routing.js";

type Session = {
  sourceID?: string;
  completionID: string;
  seenAt: number;
  route: ProgramRoute;
  client: Pick<StudioClient, "snapshot" | "transport">;
  returnRoutingID?: string;
  afterApplied?: boolean;
};

/** Program return routes belong to a playback session, across pause, buttons and page changes. */
export class PlaybackRouting {
  private sessions = new Map<number, Session>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly route: (options: RoutingOptions) => ProgramRoute | undefined;
  constructor(route: (options: RoutingOptions) => ProgramRoute | undefined) {
    this.route = route;
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async finish(id: number, acknowledge = false): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id); // An end route is attempted once, even on hardware failure.
    await this.applyAfter(session);
    if (acknowledge && session.returnRoutingID)
      await session.client.transport(
        id,
        "complete-return-routing",
        session.sourceID,
        session.returnRoutingID,
      );
  }
  private async applyAfter(session: Session): Promise<void> {
    if (session.afterApplied) return;
    await session.route.after();
    session.afterApplied = true;
  }
  transport(
    client: Pick<StudioClient, "snapshot" | "transport">,
    id: number,
    action: Transport,
    options: RoutingOptions,
    sourceID?: string,
  ): Promise<void> {
    const captured = { ...options };
    return this.serial(async () => {
      if (this.closed) throw new Error("Playback routing connection closed.");
      const status = (await client.snapshot()).playback;
      if (this.closed) throw new Error("Playback routing connection closed.");
      const tab = status?.tabs.find((tab) => tab.id === id);
      if (
        !tab ||
        !tab.loaded ||
        (tab.loading &&
          !(
            tab.returnRoutingPending &&
            !!this.sessions.get(id)?.returnRoutingID &&
            this.sessions.get(id)?.returnRoutingID?.toUpperCase() ===
              tab.returnRoutingID?.toUpperCase() &&
            ["stop", "toggle"].includes(action)
          )) ||
        tab.replay ||
        !(
          tab.sourceKind === "video" ||
          (tab.sourceKind === "audio" && status?.audioControl === true)
        )
      )
        throw new Error(`Tab ${id} has no loaded media or is busy.`);
      if (sourceID !== undefined && tab.sourceID !== sourceID)
        throw new Error(
          "The source changed while the command was queued. Try again.",
        );
      if (
        (action === "pause" || action === "restart") &&
        status?.playbackTransportControl !== true
      )
        throw new Error("Pause and Restart are unavailable in this app.");
      if (
        action === "play-pause" &&
        (tab.sourceKind !== "video" || status?.videoJogControl !== true)
      )
        throw new Error(
          "Play/Pause toggle requires a video tab with jog support.",
        );
      let existing = this.sessions.get(id);
      if (
        existing &&
        (existing.sourceID !== tab.sourceID ||
          existing.completionID !== tab.completionID)
      ) {
        await this.finish(id);
        existing = undefined;
      }
      const command =
        action === "toggle"
          ? existing || tab.playing
            ? "stop"
            : "play"
          : action === "play-pause"
            ? tab.playing
              ? "pause"
              : "play"
            : action;
      const identity = sourceID ?? tab.sourceID;
      if (command === "stop" || command === "pause") {
        if (command === "stop" && existing) await this.applyAfter(existing);
        await client.transport(
          id,
          command === "stop" && existing?.returnRoutingID
            ? "complete-return-routing"
            : command,
          identity,
          existing?.returnRoutingID && command === "stop"
            ? existing.returnRoutingID
            : undefined,
        );
        if (command === "stop") await this.finish(id);
        return;
      }
      if (existing) {
        const result = await client.transport(id, command, identity);
        existing.completionID = result.completionID ?? existing.completionID;
        existing.seenAt = status!.seenAt;
        return;
      }
      const route = this.route(captured);
      if (!route) {
        await client.transport(id, command, identity);
        return;
      }
      if (command === "play" && tab.playing)
        throw new Error(
          "Playback is already active. Stop and start it with a routed action to capture the previous Program input.",
        );
      if (status?.videoCompletionControl !== true || !tab.completionID)
        throw new Error(
          "Update Saccani Live Studio to track playback completion for ATEM routing.",
        );
      const returnRoutingID =
        tab.sourceKind === "video" && route.deferReturn
          ? randomUUID()
          : undefined;
      if (returnRoutingID && (!status.videoReturnRoutingControl || !identity))
        throw new Error(
          "Update Saccani Live Studio to coordinate Program return before output restoration.",
        );
      let started = false;
      try {
        await route.prepare();
        if (this.closed) throw new Error("Playback routing connection closed.");
        const result = await client.transport(
          id,
          command,
          identity,
          returnRoutingID,
        );
        started = true;
        if (!result.completionID)
          throw new Error(
            "The app did not confirm playback completion tracking.",
          );
        if (this.closed) throw new Error("Playback routing connection closed.");
        await route.before();
        if (this.closed) throw new Error("Playback routing connection closed.");
        this.sessions.set(id, {
          sourceID: identity,
          completionID: result.completionID,
          seenAt: status.seenAt,
          route,
          client,
          returnRoutingID,
        });
      } catch (error) {
        try {
          try {
            await route.rollback();
          } finally {
            if (started)
              await client.transport(
                id,
                returnRoutingID ? "complete-return-routing" : "stop",
                identity,
                returnRoutingID,
              );
          }
        } catch (rollback) {
          throw new Error(
            `${reason(error)}; restoration after error: ${reason(rollback)}`,
          );
        }
        throw error;
      }
    });
  }
  observe(
    status: PlaybackStatus | undefined,
    onError: (error: unknown) => void,
  ): Promise<void> {
    return this.serial(async () => {
      for (const [id, session] of this.sessions) {
        const tab = status?.tabs.find((tab) => tab.id === id);
        const pending =
          !!session.returnRoutingID &&
          tab?.returnRoutingPending === true &&
          tab.returnRoutingID?.toUpperCase() ===
            session.returnRoutingID.toUpperCase();
        if (
          (status && status.seenAt <= session.seenAt) ||
          (tab?.loading && !pending) ||
          tab?.replay
        )
          continue;
        if (
          !pending &&
          tab?.loaded &&
          tab.sourceID === session.sourceID &&
          tab.completionID === session.completionID
        )
          continue;
        try {
          await this.finish(id, pending);
        } catch (error) {
          onError(error);
        }
      }
    });
  }
  close(onError: (error: unknown) => void): Promise<void> {
    this.closed = true;
    return this.serial(async () => {
      for (const id of this.sessions.keys()) {
        try {
          await this.finish(id, true);
        } catch (error) {
          onError(error);
        }
      }
    });
  }
}
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
