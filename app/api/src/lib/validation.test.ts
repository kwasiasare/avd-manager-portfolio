import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_BODY_LENGTH,
  MAX_MESSAGE_TITLE_LENGTH,
  MAX_REASON_LENGTH,
  SESSION_HOST_NAME_PATTERN,
  SESSION_ID_PATTERN,
  validateFriendlyName,
  validateMandatoryMessageBody,
  validateMandatoryReason,
  validateOptionalTitle,
  validatePrincipalId,
  validatePrincipalType,
} from './validation';

describe('validateMandatoryReason', () => {
  it('rejects undefined', () => {
    const result = validateMandatoryReason(undefined);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.response.status).toBe(400);
  });

  it('rejects an empty string', () => {
    expect(validateMandatoryReason('').ok).toBe(false);
  });

  it('rejects a whitespace-only string', () => {
    const result = validateMandatoryReason('   ');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.response.jsonBody).toMatchObject({ code: 'missing_reason' });
  });

  it('rejects a non-string value', () => {
    expect(validateMandatoryReason(42).ok).toBe(false);
  });

  it('rejects a reason exceeding MAX_REASON_LENGTH', () => {
    const result = validateMandatoryReason('x'.repeat(MAX_REASON_LENGTH + 1));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.response.jsonBody).toMatchObject({ code: 'reason_too_long' });
  });

  it('accepts a reason at exactly MAX_REASON_LENGTH', () => {
    const result = validateMandatoryReason('x'.repeat(MAX_REASON_LENGTH));
    expect(result).toEqual({ ok: true, value: 'x'.repeat(MAX_REASON_LENGTH) });
  });

  it('accepts a normal non-empty reason and returns it unchanged', () => {
    const result = validateMandatoryReason('user requested logoff');
    expect(result).toEqual({ ok: true, value: 'user requested logoff' });
  });

  it('returns the TRIMMED value, not the raw input', () => {
    const result = validateMandatoryReason('  padded reason  ');
    expect(result).toEqual({ ok: true, value: 'padded reason' });
  });

  it('bounds the length check against the trimmed value (surrounding whitespace does not count toward the cap)', () => {
    const padded = `  ${'x'.repeat(MAX_REASON_LENGTH)}  `;
    const result = validateMandatoryReason(padded);
    expect(result).toEqual({ ok: true, value: 'x'.repeat(MAX_REASON_LENGTH) });
  });
});

describe('validateMandatoryMessageBody', () => {
  it('rejects undefined, empty, and whitespace-only', () => {
    expect(validateMandatoryMessageBody(undefined).ok).toBe(false);
    expect(validateMandatoryMessageBody('').ok).toBe(false);
    expect(validateMandatoryMessageBody('   ').ok).toBe(false);
  });

  it('rejects a body exceeding MAX_MESSAGE_BODY_LENGTH', () => {
    const result = validateMandatoryMessageBody('x'.repeat(MAX_MESSAGE_BODY_LENGTH + 1));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.response.jsonBody).toMatchObject({ code: 'body_too_long' });
  });

  it('accepts a normal body and returns the trimmed value', () => {
    const result = validateMandatoryMessageBody('  Please save your work.  ');
    expect(result).toEqual({ ok: true, value: 'Please save your work.' });
  });
});

describe('validateOptionalTitle', () => {
  it('accepts undefined (title is optional) and returns value: undefined', () => {
    expect(validateOptionalTitle(undefined)).toEqual({ ok: true, value: undefined });
  });

  it('rejects a non-string title', () => {
    expect(validateOptionalTitle(42).ok).toBe(false);
  });

  it('rejects a title exceeding MAX_MESSAGE_TITLE_LENGTH', () => {
    const result = validateOptionalTitle('x'.repeat(MAX_MESSAGE_TITLE_LENGTH + 1));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.response.jsonBody).toMatchObject({ code: 'title_too_long' });
  });

  it('accepts a normal title and returns the trimmed value', () => {
    expect(validateOptionalTitle('  Maintenance notice  ')).toEqual({ ok: true, value: 'Maintenance notice' });
  });

  it('normalizes an empty-after-trim (whitespace-only) title to undefined', () => {
    expect(validateOptionalTitle('    ')).toEqual({ ok: true, value: undefined });
  });
});

describe('SESSION_HOST_NAME_PATTERN', () => {
  it('accepts a simple host name and a dotted FQDN-style name', () => {
    expect(SESSION_HOST_NAME_PATTERN.test('avd-con-0')).toBe(true);
    expect(SESSION_HOST_NAME_PATTERN.test('avd-con-0.contoso.local')).toBe(true);
  });

  it('rejects a path-traversal-shaped value', () => {
    expect(SESSION_HOST_NAME_PATTERN.test('../etc/passwd')).toBe(false);
  });
});

describe('SESSION_ID_PATTERN', () => {
  it('accepts short numeric session ids', () => {
    expect(SESSION_ID_PATTERN.test('1')).toBe(true);
    expect(SESSION_ID_PATTERN.test('42')).toBe(true);
  });

  it('rejects a path-traversal-shaped value', () => {
    expect(SESSION_ID_PATTERN.test('../1')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(SESSION_ID_PATTERN.test('')).toBe(false);
  });
});

describe('validatePrincipalId', () => {
  it('accepts a well-formed lowercase GUID', () => {
    const result = validatePrincipalId('11111111-2222-3333-4444-555555555555');
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('accepts an uppercase GUID', () => {
    expect(validatePrincipalId('11111111-2222-3333-4444-555555555555'.toUpperCase()).ok).toBe(true);
  });

  it('rejects undefined', () => {
    const result = validatePrincipalId(undefined);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.response.jsonBody).toMatchObject({ code: 'invalid_principal_id' });
  });

  it('rejects a non-GUID string', () => {
    expect(validatePrincipalId('not-a-guid').ok).toBe(false);
  });

  it('rejects a GUID-shaped value with the wrong segment lengths', () => {
    expect(validatePrincipalId('1111-2222-3333-4444-555555555555').ok).toBe(false);
  });

  it('rejects a display name masquerading as an id', () => {
    expect(validatePrincipalId('Contoso Marketing Group').ok).toBe(false);
  });
});

describe('validatePrincipalType', () => {
  it('accepts "user"', () => {
    const result = validatePrincipalType('user');
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe('user');
  });

  it('accepts "group"', () => {
    expect(validatePrincipalType('group').ok).toBe(true);
  });

  it('rejects "admin" — not a valid PrincipalType even though it is a valid app Role', () => {
    const result = validatePrincipalType('admin');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.response.jsonBody).toMatchObject({ code: 'invalid_principal_type' });
  });

  it('rejects capitalized "User" — case-sensitive, matches ARM-facing lowercase convention exactly', () => {
    expect(validatePrincipalType('User').ok).toBe(false);
  });

  it('rejects undefined', () => {
    expect(validatePrincipalType(undefined).ok).toBe(false);
  });

  it('rejects a role-definition GUID passed where a principalType was expected — proves the request shape has no path for a caller to smuggle a role selection through this field', () => {
    expect(validatePrincipalType('1d18fff3-a72a-46b5-b4a9-0b38a3cd7e63').ok).toBe(false);
  });
});

describe('validateFriendlyName', () => {
  it('accepts and trims a normal name', () => {
    const result = validateFriendlyName('  Contoso Desktop  ');
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe('Contoso Desktop');
  });

  it('rejects an empty string — clearing the friendly name is not a silent side effect (AM-14 peer review fix 13)', () => {
    const result = validateFriendlyName('');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.response.jsonBody).toMatchObject({ code: 'friendly_name_required' });
  });

  it('rejects an all-whitespace string', () => {
    const result = validateFriendlyName('   ');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.response.jsonBody).toMatchObject({ code: 'friendly_name_required' });
  });

  it('rejects a non-string value', () => {
    expect(validateFriendlyName(42).ok).toBe(false);
  });

  it('rejects a name exceeding the max length', () => {
    const result = validateFriendlyName('x'.repeat(65));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.response.jsonBody).toMatchObject({ code: 'friendly_name_too_long' });
  });

  it('accepts a name at exactly the max length', () => {
    expect(validateFriendlyName('x'.repeat(64)).ok).toBe(true);
  });
});
