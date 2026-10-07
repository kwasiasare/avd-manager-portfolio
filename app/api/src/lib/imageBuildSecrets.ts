import { randomInt } from 'node:crypto';

/**
 * AM-27 (M4-S2) — server-generated local admin password for the throwaway
 * build VM (Opus review MAJOR 5). Originally this was an operator-supplied
 * form field; removed entirely — an admin-only wizard has no legitimate
 * reason to make the CALLER respons­ible for choosing/transmitting a VM
 * credential when this app can generate one, use it exactly once, and
 * never persist it. Returned to the caller ONE TIME in
 * StartImageBuildResponse.generatedAdminPassword (see @avdmgr/shared's doc
 * comment on that field) — same "generate, show once, never store" contract
 * this app already applies to AVD's own session-host registration token
 * (app/api/src/functions/hostPoolRegistrationToken.ts).
 *
 * Character set/length verified against @azure/arm-compute's
 * OSProfile.adminPassword doc comment (installed .d.ts, matches Microsoft's
 * "Reset the Remote Desktop service or its login password" Windows VM
 * password rules): 8-123 characters, and "3 out of 4" of
 * lower/upper/digit/special([\W_]) required. This generator GUARANTEES all
 * four categories (not just 3) so it can never accidentally land in the
 * "only 2 categories" failure case, and picks a fixed 32-character length —
 * comfortably within the 123-char ceiling, and long enough that the
 * documented list of literal disallowed passwords ("abc@123", "P@ssw0rd",
 * etc. — all far shorter) cannot match by construction.
 *
 * Uses `node:crypto`'s `randomInt` (a CSPRNG-backed bounded random integer)
 * for every character choice and for the Fisher-Yates shuffle — never
 * `Math.random()`, which is not cryptographically secure and must not be
 * used to generate a credential.
 */

/** Visually-ambiguous characters (I/l/1, O/0) are excluded from every category below — this password is never meant to be typed by a human, but keeping it copy/paste-unambiguous costs nothing and helps if an operator ever needs to read it off screen. Quote/backslash/backtick characters are excluded from SPECIAL_CHARS so the value never needs escaping wherever it's later serialized (ARM request JSON body). */
const LOWER_CHARS = 'abcdefghjkmnpqrstuvwxyz';
const UPPER_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGIT_CHARS = '23456789';
const SPECIAL_CHARS = '!@#$%^&*-_=+';
const ALL_CHARS = LOWER_CHARS + UPPER_CHARS + DIGIT_CHARS + SPECIAL_CHARS;

const PASSWORD_LENGTH = 32;

function randomChar(charset: string): string {
  return charset[randomInt(charset.length)];
}

/** Generates a fresh 32-character password guaranteed to contain at least one lowercase, one uppercase, one digit, and one special character. */
export function generateBuildAdminPassword(): string {
  const chars: string[] = [randomChar(LOWER_CHARS), randomChar(UPPER_CHARS), randomChar(DIGIT_CHARS), randomChar(SPECIAL_CHARS)];
  while (chars.length < PASSWORD_LENGTH) {
    chars.push(randomChar(ALL_CHARS));
  }
  // Fisher-Yates shuffle (crypto-random) so the four guaranteed-category
  // characters aren't predictably at the front of every generated password.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
