import { Children, cloneElement, isValidElement, useCallback, useMemo, type ReactElement } from 'react';
import { ToastBody, useToastController } from '@fluentui/react-components';
import { IS_DEMO } from './config';
import { SIMULATED_TOAST_TEXT, wasJustSimulated } from '../demo/simulatedSignal';

/**
 * AM-29 item 28 — a single, fixed Toaster id shared by Layout's <Toaster>
 * (the one place the toast surface actually renders — see Layout.tsx) and
 * every page/component that dispatches a toast via useAppToast() below. A
 * plain module-level constant (rather than a React context carrying a
 * useId()-generated id) works here because there is exactly ONE Toaster in
 * the whole app, mounted once in the persistent shell — no prop drilling or
 * provider needed for something that's effectively a singleton.
 */
export const TOASTER_ID = 'avdmgr-toaster';

/**
 * Thin wrapper over Fluent's useToastController, scoped to the app's one
 * Toaster (see TOASTER_ID). Use for TRANSIENT successes only (drain
 * toggled, ack/snooze, message sent, friendly-name saved, ...) — keep
 * MessageBars for anything the operator needs to keep reading (batch
 * results with per-item failures, "may still be running" warnings,
 * degradation banners) per this item's own scope note.
 */
export function useAppToast() {
  const controller = useToastController(TOASTER_ID);
  const { dispatchToast } = controller;

  // AM-60 — in the public demo, a success toast that follows a simulated
  // mutation gets a "Simulated — not applied to any Azure resource" line, so
  // no page needs to know it is running against the demo transport.
  const dispatchWithDemoSuffix = useCallback<typeof dispatchToast>(
    (content, options) => {
      if (IS_DEMO && wasJustSimulated() && isValidElement(content)) {
        const toast = content as ReactElement<{ children?: React.ReactNode }>;
        const children = [...Children.toArray(toast.props.children), <ToastBody key="demo-simulated">{SIMULATED_TOAST_TEXT}</ToastBody>];
        return dispatchToast(cloneElement(toast, undefined, ...children), options);
      }
      return dispatchToast(content, options);
    },
    [dispatchToast],
  );

  return useMemo(() => (IS_DEMO ? { ...controller, dispatchToast: dispatchWithDemoSuffix } : controller), [controller, dispatchWithDemoSuffix]);
}
