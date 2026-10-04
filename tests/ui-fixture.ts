import { Match, Wire } from '../play/src/engine/index.js';
import type { Action } from '../play/src/engine/index.js';
import { Session, type Channel, type ChannelStatus, type Room, type RoomAction } from '../play/src/transport.js';

type Options = { peers: string[]; remoteName: string; remoteExport?: string };
type Packet = { text: string; sender: string; target: string };

export function makeRoom(options: Options): Room {
  const localId = 'ui-player';
  const channels = new Map<string, Channel>();
  const sessions = new Map<string, Session>();
  const queue: Packet[] = [];
  const held: Packet[] = [];
  let hold = false;
  let action: RoomAction | null = null;
  let draining = false;
  function flush() {
    if (draining) return;
    draining = true;
    queueMicrotask(() => {
      for (const packet of queue.splice(0)) {
        if (hold && JSON.parse(packet.text).type === 'reveal') held.push(packet);
        else if (packet.target === localId) action?.onMessage?.(packet.text, { peerId: packet.sender });
        else channels.get(packet.target)?.onMessage?.(packet.text, packet.sender);
      }
      draining = false;
      if (queue.length) flush();
    });
  }
  function send(text: string, sender: string) {
    for (const target of [localId, ...channels.keys()]) {
      if (target !== sender) queue.push({ text, sender, target });
    }
    flush();
  }
  const room: Room = {
    onPeerJoin: null, onPeerLeave: null,
    getPeers: () => Object.fromEntries(options.peers.map((id) => [id, {}])),
    makeAction: () => (action = { send: (text) => send(text, localId), onMessage: null }),
    leave: () => { for (const session of sessions.values()) session.close(); },
  };
  const params = new URLSearchParams(location.hash.slice(1));
  const saved = params.get('resume');
  const fresh = params.get('join');
  const config = Wire.decodeMatchCode(fresh ?? '');
  const loaded = saved ? Match.fromExport(saved) : null;
  if (saved && !loaded?.ok) throw new Error(loaded && !loaded.ok ? loaded.error : 'invalid resume');
  if (!saved && !config.ok) throw new Error(config.error);
  const original = loaded?.ok ? loaded.value.match : config.ok ? Match.fromConfig(config.value) : null;
  if (!original) throw new Error('missing fixture match');
  const names = loaded?.ok ? loaded.value.names : null;
  for (const id of options.peers) {
    let status: Channel['onStatus'] = null;
    const channel: Channel = {
      id, onMessage: null, onStatus: null,
      send: (text) => send(text, id), close: () => {},
    };
    Object.defineProperty(channel, 'onStatus', {
      get: () => status,
      set: (callback: Channel['onStatus']) => {
        status = callback;
        const value: ChannelStatus = { state: 'live', peers: [localId, ...options.peers.filter((other) => other !== id)], detail: null };
        callback?.(value);
      },
    });
    channels.set(id, channel);
    const copy = Match.fromExport(options.remoteExport ?? original.export(names));
    if (!copy.ok) throw new Error(copy.error);
    sessions.set(id, new Session({ match: copy.value.match, channel, entry: saved ? 'resume' : 'join', names: copy.value.names }));
  }
  Object.assign(window.__tbtt, {
    ready: () => {
      for (const [index, session] of [...sessions.values()].entries()) {
        if (saved) {
          const local = session.view().seats.find((seat) => seat.ownerId === localId)?.color;
          const color = original.config().roster.filter((c) => c !== local)[index];
          if (color) session.requestSeat(color);
        }
        else session.join(index === 0 ? options.remoteName : `Peer${index + 1}`);
      }
    },
    consent: () => { for (const session of sessions.values()) session.ready(); },
    commit: async (value: string, color = 'P') => {
      hold = true;
      const session = [...sessions.values()].find((peer) => peer.color() === color);
      if (!session) throw new Error(`no fixture owner for ${color}`);
      const result = await session.commit(value as Action);
      if (!result.ok) throw new Error(result.error ?? 'fixture commitment failed');
    },
    release: () => { hold = false; queue.push(...held.splice(0)); flush(); },
    views: () => [...sessions.values()].map((session) => session.view()),
    inject: (text: string, sender = 'foreign') => action?.onMessage?.(text, { peerId: sender }),
    depart: (id = options.peers[0]) => {
      if (!id) return;
      sessions.get(id)?.close(); sessions.delete(id); channels.delete(id);
      options.peers = options.peers.filter((peer) => peer !== id);
      room.onPeerLeave?.(id);
    },
  });
  return room;
}
