import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../play/src/engine/index.js';
import { Session } from '../play/src/transport.js';
import { QueuedNetwork } from './helpers/queued-channel.js';

it('a delayed lower-ID contender cannot displace an agreed owner or split completed turns', async () => {
  const network = new QueuedNetwork();
  const open = (id: string, entry: 'create' | 'join') => Session.open({
    channel: network.connect(id), entry,
    match: Match.fromConfig({
      mode: 'sandbox', w: 16, h: 9, wallPct: 0, seed: 'seat-race', cap: 40, roster: ['C', 'P']
    })
  });
  const coral = open('zzCoral', 'create'), purple = open('purple', 'join');
  let contender: ReturnType<typeof Session.open> | undefined;
  try {
    assert.ok(coral.join('High').ok);
    assert.ok(purple.join('Purple').ok);
    await network.pump();
    assert.ok(coral.ready().ok);
    assert.ok(purple.ready().ok);
    await network.pump();
    assert.equal(coral.color(), 'C');
    assert.equal(purple.color(), 'P');
    assert.equal(coral.view().canCommit, true);

    contender = open('aaCoral', 'join');
    assert.ok(contender.join('Low').ok);
    await network.pump((message) => message.from !== 'aaCoral');
    assert.equal((await contender.commit('D')).ok, false);
    assert.ok((await coral.commit('D')).ok);
    assert.ok((await purple.commit('A')).ok);
    await network.pump((message) => message.from !== 'aaCoral');
    assert.equal(coral.view().turn, 1);
    assert.equal(purple.view().turn, 1);

    await network.pump();
    assert.equal(coral.color(), 'C');
    assert.equal(contender.color(), null);
    assert.equal(coral.view().hostId, 'zzCoral');
    assert.equal(coral.view().turn, purple.view().turn);
    assert.equal(coral.export(), purple.export());
    assert.equal(contender.view().canCommit, false);
  } finally {
    coral.close(); purple.close(); contender?.close();
  }
});
