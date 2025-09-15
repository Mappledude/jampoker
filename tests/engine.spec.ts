import { strict as assert } from 'assert';
import { applyAction, HandState } from '../src/lib/poker/engine';

describe('engine applyAction', () => {
  function baseHeadsUp(): HandState {
    return {
      handNo: 1,
      street: 'preflop',
      dealerSeat: 1,
      sbSeat: 1,
      bbSeat: 0,
      toActSeat: 1,
      betToMatchCents: 50,
      commits: { '0': 50, '1': 25 },
      lastAggressorSeat: null,
      activeSeats: [true, true, false, false, false, false, false, false, false],
    };
  }

  it('heads-up call then check to flop', () => {
    let state = baseHeadsUp();
    state = applyAction(state, { handNo: 1, seat: 1, type: 'call' });
    assert.equal(state.commits['1'], 50);
    assert.equal(state.toActSeat, 0);
    assert.equal(state.street, 'preflop');

    state = applyAction(state, { handNo: 1, seat: 0, type: 'check' });
    assert.equal(state.street, 'flop');
    assert.deepEqual(state.commits, {});
    assert.equal(state.toActSeat, 0);
  });

  it('heads-up open raise', () => {
    let state = baseHeadsUp();
    state = applyAction(state, { handNo: 1, seat: 1, type: 'raise', amountCents: 125 });
    assert.equal(state.betToMatchCents, 150);
    assert.equal(state.lastAggressorSeat, 1);
    assert.equal(state.toActSeat, 0);

    state = applyAction(state, { handNo: 1, seat: 0, type: 'call' });
    assert.equal(state.street, 'flop');
    assert.equal(state.toActSeat, 0);
    assert.equal(state.betToMatchCents, 0);
    assert.deepEqual(state.commits, {});
  });

  it('three handed round trip', () => {
    let state: HandState = {
      handNo: 1,
      street: 'preflop',
      dealerSeat: 0,
      sbSeat: 1,
      bbSeat: 2,
      toActSeat: 0,
      betToMatchCents: 50,
      commits: { '1': 25, '2': 50 },
      lastAggressorSeat: null,
      activeSeats: [true,true,true,false,false,false,false,false,false],
    };
    state = applyAction(state, { handNo:1, seat:0, type:'raise', amountCents:100 });
    state = applyAction(state, { handNo:1, seat:1, type:'call' });
    state = applyAction(state, { handNo:1, seat:2, type:'call' });
    assert.equal(state.street, 'flop');
    assert.equal(state.toActSeat, 1); // BB (seat2) acted last, so flop starts at seat1 (sb left of dealer)
    assert.deepEqual(state.commits, {});
  });
});
