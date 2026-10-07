import { afterEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/renderWithProviders';
import TableScroll from './TableScroll';

/**
 * jsdom does no real layout — scrollWidth/clientWidth are both 0 by default
 * — so these tests stub the two properties on HTMLElement.prototype to
 * simulate an overflowing (or not) container. Restored after each test so
 * the stub doesn't leak into other files' tests.
 */
function stubOverflow(scrollWidth: number, clientWidth: number) {
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: clientWidth });
}

function restoreOverflowStub() {
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth');
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
}

describe('TableScroll', () => {
  afterEach(restoreOverflowStub);

  it('renders its children inside a labeled region', () => {
    renderWithProviders(
      <TableScroll ariaLabel="Test table">
        <table>
          <tbody>
            <tr>
              <td>content</td>
            </tr>
          </tbody>
        </table>
      </TableScroll>,
    );
    expect(screen.getByText('content')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Test table' })).toBeInTheDocument();
  });

  it('is keyboard-focusable (tabindex=0) when its content actually overflows', () => {
    stubOverflow(800, 400);
    renderWithProviders(
      <TableScroll ariaLabel="Wide table">
        <table>
          <tbody>
            <tr>
              <td>content</td>
            </tr>
          </tbody>
        </table>
      </TableScroll>,
    );
    expect(screen.getByRole('region', { name: 'Wide table' })).toHaveAttribute('tabindex', '0');
  });

  it('is NOT in tab order when its content does not overflow', () => {
    stubOverflow(200, 400);
    renderWithProviders(
      <TableScroll ariaLabel="Narrow table">
        <table>
          <tbody>
            <tr>
              <td>content</td>
            </tr>
          </tbody>
        </table>
      </TableScroll>,
    );
    expect(screen.getByRole('region', { name: 'Narrow table' })).not.toHaveAttribute('tabindex');
  });
});
