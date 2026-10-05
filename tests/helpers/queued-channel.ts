import type { Channel, ChannelStatus } from '../../play/src/transport.js';

export type Delivery = { from: string; to: string; text: string };

export function messageType(message: Delivery): string {
  try { return (JSON.parse(message.text) as { type?: string }).type ?? ''; }
  catch { return ''; }
}

export class QueuedNetwork {
  readonly messages: Delivery[] = [];
  readonly sent: Delivery[] = [];
  private ends = new Map<string, Channel>();
  private peerViews = new Map<string, string[]>();

  setPeerView(id: string, peers: string[]): void {
    this.peerViews.set(id, peers.slice());
    this.report();
  }

  private peers(id: string): string[] {
    return this.peerViews.get(id)?.filter((peer) => this.ends.has(peer)) ??
      [...this.ends.keys()].filter((peer) => peer !== id);
  }

  connect(id: string): Channel {
    if (this.ends.has(id)) throw new Error('duplicate peer ' + id);
    let listener: Channel['onStatus'] = null;
    const status = (): ChannelStatus => ({
      state: 'live', peers: this.peers(id), detail: null
    });
    const channel: Channel = {
      id,
      onMessage: null,
      get onStatus() { return listener; },
      set onStatus(fn) { listener = fn; fn?.(status()); },
      send: (text) => {
        for (const to of this.ends.keys()) if (to !== id) {
          const message = { from: id, to, text };
          this.messages.push(message);
          this.sent.push({ ...message });
        }
      },
      close: () => {
        if (!this.ends.delete(id)) return;
        listener?.({ state: 'offline', peers: [], detail: null });
        this.report();
      }
    };
    this.ends.set(id, channel);
    this.report();
    return channel;
  }

  private report(): void {
    for (const [id, channel] of this.ends) channel.onStatus?.({
      state: 'live', peers: this.peers(id), detail: null
    });
  }

  deliverWhere(predicate: (message: Delivery) => boolean): number {
    const selected = this.messages.filter(predicate);
    for (const message of selected) {
      this.messages.splice(this.messages.indexOf(message), 1);
      this.inject(message);
    }
    return selected.length;
  }

  inject(message: Delivery): void {
    this.ends.get(message.to)?.onMessage?.(message.text, message.from);
  }

  async pumpUntil(settled: () => boolean): Promise<void> {
    const deadline = performance.now() + 5_000;
    do {
      await this.pump();
      if (settled()) return;
    } while (performance.now() < deadline);
    throw new Error('queued network did not reach the expected state within 5 seconds');
  }

  async pump(predicate: (message: Delivery) => boolean = () => true): Promise<void> {
    let idle = 0;
    for (let cycle = 0; cycle < 200; cycle++) {
      const delivered = this.deliverWhere(predicate);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (delivered === 0 && !this.messages.some(predicate)) idle++;
      else idle = 0;
      if (idle === 6) return;
    }
    throw new Error('queued network did not settle within 200 delivery cycles');
  }
}
