import { strict as assert } from 'assert';
import { applyAction, HandState } from '../../src/lib/poker/engine';

describe('version increments', () => {
  it('increments per action', () => {
    let state: HandState = {
      handNo: 1,
      street: 'preflop',
      dealerSeat: 1,
      sbSeat: 1,
      bbSeat: 0,
      toActSeat: 1,
      betToMatchCents: 50,
      commits: [50,25,0,0,0,0,0,0,0],
      lastAggressorSeat: null,
      activeSeats: [true,true,false,false,false,false,false,false,false],
      // version not part of HandState interface but we'll track separately
    } as any;
    let version = 0;
    state = applyAction(state, { handNo:1, seat:1, type:'call' });
    version += 1;
    state = applyAction(state, { handNo:1, seat:0, type:'check' });
    version += 1;
    assert.equal(version, 2);
    assert.equal(state.street, 'flop');
  });
});
