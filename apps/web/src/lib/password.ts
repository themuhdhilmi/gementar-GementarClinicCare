/**
 * Live feedback while someone chooses a password. Length is what matters, so
 * that is what the meter rewards; the server has the final say, including the
 * breach check, and its message is shown verbatim when it refuses.
 */
export type Strength = {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  hint: string;
};

const SEQUENCES = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '0123456789', 'abcdefghijklmnopqrstuvwxyz'];

export function assessPassword(value: string, context: { email?: string; name?: string } = {}): Strength {
  const length = value.length;

  if (length === 0) {
    return { score: 0, label: 'Empty', hint: 'At least 12 characters. A short phrase works well.' };
  }
  if (length < 12) {
    return {
      score: 0,
      label: 'Too short',
      hint: `${12 - length} more character${12 - length === 1 ? '' : 's'} to go.`,
    };
  }
  if (context.email && value.trim().toLowerCase() === context.email.trim().toLowerCase()) {
    return { score: 0, label: 'Not allowed', hint: 'Your password cannot be your email address.' };
  }
  if (context.name && value.trim().toLowerCase() === context.name.trim().toLowerCase()) {
    return { score: 0, label: 'Not allowed', hint: 'Your password cannot be your own name.' };
  }

  const lower = value.toLowerCase();
  const runOfOne = /(.)\1{3,}/.test(value);
  const straightFromTheKeyboard = SEQUENCES.some((seq) => {
    for (let i = 0; i + 6 <= seq.length; i += 1) {
      if (lower.includes(seq.slice(i, i + 6))) return true;
    }
    return false;
  });

  if (runOfOne || straightFromTheKeyboard) {
    return {
      score: 1,
      label: 'Predictable',
      hint: 'Repeated characters and keyboard runs are the first thing cracking tools try.',
    };
  }

  const variety = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  const words = value.trim().split(/[\s-]+/).filter((w) => w.length > 2).length;

  if (length >= 20 || (length >= 16 && words >= 3)) {
    return { score: 4, label: 'Strong', hint: 'Long enough to be genuinely hard to guess.' };
  }
  if (length >= 16 || variety >= 3 || words >= 3) {
    return { score: 3, label: 'Good', hint: 'Fine. A few more words would be better than a symbol.' };
  }
  return { score: 2, label: 'Acceptable', hint: 'Length beats symbols: try adding another word.' };
}
