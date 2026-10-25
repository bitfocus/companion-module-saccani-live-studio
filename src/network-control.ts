// Saccani Live Studio Control API v1. Keep this file identical in both controller repositories.
import { randomUUID } from 'node:crypto';

export type APIConnection = { url: string; token?: string };
export type APIOperation = {
  id: string;
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  error?: { code: string; message: string };
  completionID?: string;
};
export type APISnapshot = { playback?: Record<string, unknown>; replay?: Record<string, unknown>; operations?: APIOperation[] };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function operation(value: unknown, id: string): APIOperation {
  if (!object(value) || typeof value.id !== 'string' || value.id.toUpperCase() !== id.toUpperCase() || !['running', 'completed', 'failed', 'cancelled'].includes(String(value.state))) {
    throw new Error('Invalid Saccani Live Studio operation response.');
  }
  return value as APIOperation;
}

export class NetworkControl {
  private readonly base: URL;
  private socket?: WebSocket;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private lastConnect = 0;
  private receivedAt = 0;
  private latest?: APISnapshot;
  private sequence = -1;
  private instanceId = '';
  private closed = false;
  private pending = new Set<AbortController>();
  private readonly connection: APIConnection;
  constructor(connection: APIConnection) {
    this.connection = connection;
    this.base = new URL(connection.url);
    if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash || this.base.pathname !== '/') {
      throw new Error('Enter the app API base URL, for example http://127.0.0.1:8765.');
    }
    if (connection.token && !/^[a-f0-9]{64}$/i.test(connection.token)) throw new Error('Copy the API access token from Saccani Live Studio → Settings… → Remote Control.');
  }
  private connect(): void {
    if (this.closed || this.socket || Date.now() - this.lastConnect < 2000) return;
    this.lastConnect = Date.now();
    const url = new URL('/api/v1/events', this.base);
    url.protocol = this.base.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url, this.connection.token ? ['sls.v1', `sls.auth.${this.connection.token}`] : ['sls.v1']);
    this.socket = socket;
    this.handshakeTimer = setTimeout(() => {
      if (this.socket === socket && socket.readyState !== WebSocket.OPEN) socket.close();
    }, 3000);
    this.handshakeTimer.unref?.();
    socket.addEventListener('open', () => { clearTimeout(this.handshakeTimer); this.sequence = -1; this.instanceId = ''; });
    socket.addEventListener('message', event => {
      if (this.socket !== socket || typeof event.data !== 'string' || event.data.length > 1_048_576) return;
      try {
        const value: unknown = JSON.parse(event.data);
        if (!object(value) || value.event !== 'studio.snapshot' || typeof value.instanceId !== 'string' || !Number.isSafeInteger(value.sequence) || !object(value.data)) return;
        if (value.instanceId === this.instanceId && Number(value.sequence) <= this.sequence) return;
        const snapshot = this.validateSnapshot(value.data);
        this.instanceId = value.instanceId; this.sequence = Number(value.sequence);
        this.latest = snapshot; this.receivedAt = Date.now();
      } catch { /* Invalid events never extend the freshness deadline. HTTP remains available. */ }
    });
    const disconnected = () => {
      if (this.socket !== socket) return;
      clearTimeout(this.handshakeTimer); this.socket = undefined; this.latest = undefined; this.receivedAt = 0;
      if (socket.readyState < WebSocket.CLOSING) socket.close();
    };
    socket.addEventListener('close', disconnected);
    socket.addEventListener('error', disconnected);
  }
  private validateSnapshot(value: unknown): APISnapshot {
    if (!object(value) || !object(value.playback) || !Array.isArray(value.playback.tabs) || !object(value.replay) || typeof value.replay.busy !== 'boolean') {
      throw new Error('Invalid Saccani Live Studio snapshot.');
    }
    // Freshness is measured on the receiving controller, avoiding clock skew between hosts.
    const seenAt = Date.now() / 1000;
    return { ...value, playback: { ...value.playback, seenAt }, replay: { ...value.replay, seenAt } };
  }
  private async http(path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error('Connection closed.');
    const controller = new AbortController(); this.pending.add(controller);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(() => controller.abort(new Error('Saccani Live Studio API request timed out; the command was not retried.')), 5000);
    try {
      const response = await fetch(new URL(path, this.base), {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
        headers: { ...(this.connection.token ? { Authorization: `Bearer ${this.connection.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const value: unknown = await response.json();
      if (!response.ok) {
        const message = object(value) && object(value.error) && typeof value.error.message === 'string' ? value.error.message : `HTTP ${response.status}`;
        throw new Error(`Saccani Live Studio: ${message}`);
      }
      return value;
    } finally {
      clearTimeout(timeout); signal?.removeEventListener('abort', abort); this.pending.delete(controller);
    }
  }
  async snapshot(force = false): Promise<APISnapshot> {
    this.connect();
    if (!force && this.latest && Date.now() - this.receivedAt < 1500) return this.latest;
    return this.validateSnapshot(await this.http('/api/v1/status'));
  }
  async submit(path: string, parameters: Record<string, unknown>, id = randomUUID().toUpperCase(), signal?: AbortSignal): Promise<APIOperation> {
    this.connect();
    return operation(await this.http(path, { ...parameters, id }, signal), id);
  }
  async wait(id: string, timeoutMs = 5000, signal?: AbortSignal): Promise<APIOperation> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.closed) throw new Error('Connection closed.');
      signal?.throwIfAborted();
      this.connect();
      let result = this.latest && Date.now() - this.receivedAt < 1500 ? this.latest.operations?.find(item => item.id.toUpperCase() === id.toUpperCase()) : undefined;
      if (!result) result = operation(await this.http(`/api/v1/operations/${id}`, undefined, signal), id);
      result = operation(result, id);
      if (result.state === 'failed') throw new Error(result.error?.message ?? 'Saccani Live Studio command failed.');
      if (result.state === 'cancelled') throw new Error('Saccani Live Studio operation was cancelled.');
      if (result.state === 'completed') return result;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason ?? new Error('Aborted')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 100);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
    throw new Error('Saccani Live Studio did not confirm the command; it was not retried.');
  }
  async command(tab: number, action: string, parameters: Record<string, unknown> = {}, signal?: AbortSignal): Promise<APIOperation> {
    const accepted = await this.submit(`/api/v1/tabs/${tab}/${action}`, parameters, undefined, signal);
    // Output handoff and AVPlayer preroll can outlast an individual HTTP request.
    const timeout = ['play', 'restart', 'toggle', 'play-pause', 'complete-return-routing'].includes(action) ? 15000 : 5000;
    return this.wait(accepted.id, timeout, signal);
  }
  async stopReplay(operationId: string): Promise<void> {
    const accepted = await this.submit('/api/v1/replay/stop', { operationId });
    await this.wait(accepted.id);
  }
  close(): void {
    this.closed = true; clearTimeout(this.handshakeTimer);
    this.socket?.close(); this.socket = undefined;
    for (const controller of this.pending) controller.abort();
    this.latest = undefined;
  }
}
