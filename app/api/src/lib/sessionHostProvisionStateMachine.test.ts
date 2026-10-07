import { describe, expect, it } from 'vitest';
import { canTransition, assertTransition, isTerminalState, IllegalSessionHostProvisionTransitionError, TERMINAL_STATES, TIMER_DRIVEN_STATES } from './sessionHostProvisionStateMachine';
import type { SessionHostProvisionState } from '@avdmgr/shared';

const HAPPY_PATH: SessionHostProvisionState[] = ['planned', 'nic_creating', 'vm_creating', 'ext_entra_join', 'ext_guest_attestation', 'ext_dsc', 'awaiting_registration', 'done'];

describe('canTransition — the happy path', () => {
  it('allows every consecutive pair on the documented happy path', () => {
    for (let i = 0; i < HAPPY_PATH.length - 1; i++) {
      expect(canTransition(HAPPY_PATH[i], HAPPY_PATH[i + 1])).toBe(true);
    }
  });

  it('never allows skipping a state (e.g. planned -> vm_creating directly)', () => {
    expect(canTransition('planned', 'vm_creating')).toBe(false);
    expect(canTransition('nic_creating', 'ext_entra_join')).toBe(false);
    expect(canTransition('vm_creating', 'ext_guest_attestation')).toBe(false);
  });

  it('never allows going backwards', () => {
    expect(canTransition('vm_creating', 'nic_creating')).toBe(false);
    expect(canTransition('done', 'awaiting_registration')).toBe(false);
  });
});

describe('canTransition — failed/cancelled edges from every non-terminal state', () => {
  const NON_TERMINAL: SessionHostProvisionState[] = ['planned', 'nic_creating', 'vm_creating', 'ext_entra_join', 'ext_guest_attestation', 'ext_dsc', 'awaiting_registration'];

  it.each(NON_TERMINAL)('%s -> failed and %s -> cancelled are both legal', (state) => {
    expect(canTransition(state, 'failed')).toBe(true);
    expect(canTransition(state, 'cancelled')).toBe(true);
  });

  it('unlike ImageBuildState, there is no state where cancel is blocked (no cleanup phase to protect)', () => {
    expect(canTransition('awaiting_registration', 'cancelled')).toBe(true);
  });
});

describe('terminal states have no outgoing edges', () => {
  it.each(['done', 'failed', 'cancelled'] as SessionHostProvisionState[])('%s has zero legal transitions', (state) => {
    expect(canTransition(state, 'done')).toBe(false);
    expect(canTransition(state, 'failed')).toBe(false);
    expect(canTransition(state, 'cancelled')).toBe(false);
  });
});

describe('isTerminalState / TERMINAL_STATES', () => {
  it('matches @avdmgr/shared\'s SESSION_HOST_PROVISION_TERMINAL_STATES exactly', () => {
    expect(TERMINAL_STATES.size).toBe(3);
    expect(isTerminalState('done')).toBe(true);
    expect(isTerminalState('failed')).toBe(true);
    expect(isTerminalState('cancelled')).toBe(true);
    expect(isTerminalState('planned')).toBe(false);
  });
});

describe('TIMER_DRIVEN_STATES — every non-terminal state (no operator gates in this workflow)', () => {
  it('contains all 7 non-terminal states', () => {
    expect(TIMER_DRIVEN_STATES.size).toBe(7);
    for (const state of HAPPY_PATH.slice(0, -1)) {
      expect(TIMER_DRIVEN_STATES.has(state)).toBe(true);
    }
  });

  it('does not contain any terminal state', () => {
    expect(TIMER_DRIVEN_STATES.has('done')).toBe(false);
    expect(TIMER_DRIVEN_STATES.has('failed')).toBe(false);
    expect(TIMER_DRIVEN_STATES.has('cancelled')).toBe(false);
  });
});

describe('assertTransition', () => {
  it('does not throw for a legal transition', () => {
    expect(() => assertTransition('planned', 'nic_creating')).not.toThrow();
  });

  it('throws IllegalSessionHostProvisionTransitionError for an illegal transition, carrying from/to', () => {
    try {
      assertTransition('done', 'planned');
      throw new Error('expected assertTransition to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalSessionHostProvisionTransitionError);
      expect((error as IllegalSessionHostProvisionTransitionError).from).toBe('done');
      expect((error as IllegalSessionHostProvisionTransitionError).to).toBe('planned');
    }
  });
});
