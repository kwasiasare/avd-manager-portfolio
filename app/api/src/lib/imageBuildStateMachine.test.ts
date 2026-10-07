import { describe, expect, it } from 'vitest';
import type { ImageBuildState, PowerState } from '@avdmgr/shared';
import {
  IllegalImageBuildTransitionError,
  OPERATOR_GATED_STATES,
  TERMINAL_STATES,
  TIMER_DRIVEN_STATES,
  assertTransition,
  canTransition,
  isPoweredOffForCapture,
  isTerminalState,
} from './imageBuildStateMachine';

const ALL_STATES: ImageBuildState[] = [
  'planned',
  'vm_creating',
  'vm_ready',
  'checklist_gate',
  'snapshotting',
  'sysprep_running',
  'awaiting_stopped',
  'capturing',
  'test_host_step',
  'cleanup',
  'done',
  'failed',
  'cancelled',
];

describe('canTransition — the documented forward path', () => {
  it('walks the whole documented happy path', () => {
    const path: ImageBuildState[] = [
      'planned',
      'vm_creating',
      'vm_ready',
      'checklist_gate',
      'snapshotting',
      'sysprep_running',
      'awaiting_stopped',
      'capturing',
      'test_host_step',
      'cleanup',
      'done',
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('every non-terminal state can transition to failed', () => {
    for (const state of ALL_STATES) {
      if (isTerminalState(state)) continue;
      if (state === 'cleanup') continue; // cleanup -> failed IS allowed; see next assertion for the full cleanup edge set
      expect(canTransition(state, 'failed')).toBe(true);
    }
    expect(canTransition('cleanup', 'failed')).toBe(true);
  });

  it('every state can transition to cancelled EXCEPT cleanup and the terminal states', () => {
    for (const state of ALL_STATES) {
      const expected = !isTerminalState(state) && state !== 'cleanup';
      expect(canTransition(state, 'cancelled')).toBe(expected);
    }
  });

  it('rejects skipping states (e.g. planned straight to checklist_gate)', () => {
    expect(canTransition('planned', 'checklist_gate')).toBe(false);
    expect(canTransition('vm_creating', 'snapshotting')).toBe(false);
    expect(canTransition('checklist_gate', 'sysprep_running')).toBe(false);
  });

  it('rejects moving backward', () => {
    expect(canTransition('capturing', 'awaiting_stopped')).toBe(false);
    expect(canTransition('done', 'cleanup')).toBe(false);
  });

  it('terminal states have no outgoing edges at all', () => {
    for (const terminal of TERMINAL_STATES) {
      for (const target of ALL_STATES) {
        expect(canTransition(terminal, target)).toBe(false);
      }
    }
  });
});

describe('assertTransition — illegal-transition rejection', () => {
  it('does not throw for a legal transition', () => {
    expect(() => assertTransition('checklist_gate', 'snapshotting')).not.toThrow();
  });

  it('throws IllegalImageBuildTransitionError, carrying from/to, for an illegal transition', () => {
    expect(() => assertTransition('done', 'vm_creating')).toThrow(IllegalImageBuildTransitionError);
    try {
      assertTransition('done', 'vm_creating');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalImageBuildTransitionError);
      const typed = error as IllegalImageBuildTransitionError;
      expect(typed.from).toBe('done');
      expect(typed.to).toBe('vm_creating');
      expect(typed.message).toContain('done -> vm_creating');
    }
  });

  it('rejects cancelling out of cleanup (deletes are already firing)', () => {
    expect(() => assertTransition('cleanup', 'cancelled')).toThrow(IllegalImageBuildTransitionError);
  });
});

describe('OPERATOR_GATED_STATES / TIMER_DRIVEN_STATES — disjoint, and cover every non-terminal state exactly once (plus "planned")', () => {
  it('checklist_gate and test_host_step are operator-gated, nothing else is', () => {
    expect(OPERATOR_GATED_STATES).toEqual(new Set(['checklist_gate', 'test_host_step']));
  });

  it('no state is both operator-gated and timer-driven', () => {
    for (const state of OPERATOR_GATED_STATES) {
      expect(TIMER_DRIVEN_STATES.has(state)).toBe(false);
    }
  });

  it('every non-terminal, non-planned, non-operator-gated state is timer-driven', () => {
    for (const state of ALL_STATES) {
      if (isTerminalState(state) || state === 'planned' || OPERATOR_GATED_STATES.has(state)) continue;
      expect(TIMER_DRIVEN_STATES.has(state)).toBe(true);
    }
  });
});

describe('isPoweredOffForCapture — the awaiting_stopped HARD GATE', () => {
  it('refuses capture while the VM is running (the critical case: capture must never proceed on a live VM)', () => {
    expect(isPoweredOffForCapture('running')).toBe(false);
  });

  it.each<PowerState>(['starting', 'stopping', 'deallocating', 'unknown'])('refuses capture while power state is %s (transitional/unknown, not confirmed off)', (state) => {
    expect(isPoweredOffForCapture(state)).toBe(false);
  });

  it('allows capture once stopped (in-guest shutdown, e.g. Sysprep /shutdown)', () => {
    expect(isPoweredOffForCapture('stopped')).toBe(true);
  });

  it('allows capture once deallocated', () => {
    expect(isPoweredOffForCapture('deallocated')).toBe(true);
  });
});
