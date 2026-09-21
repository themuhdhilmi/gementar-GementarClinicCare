import { AppError } from '../../../shared/errors/domain-errors.js';

/**
 * TEN-T-10: a settings change that names something that is not a setting is
 * refused with 422 and told which key, rather than being quietly dropped.
 */
export class SettingsRejectedError extends AppError {
  constructor(readonly problems: string[]) {
    super(
      422,
      'settings_invalid',
      'Setting rejected',
      problems.join('; '),
      { problems },
    );
  }
}

/**
 * TEN-F-05: the module exists but this clinic has not switched it on. 403
 * rather than 404, because the route is real and the answer is "not for you,
 * yet" — which is a conversation with sales, not a bug report.
 */
export class ModuleDisabledError extends AppError {
  constructor(label: string) {
    super(
      403,
      'module_disabled',
      'Module not enabled',
      `${label} is not switched on for this clinic. An administrator can ask for it to be enabled.`,
    );
  }
}

/**
 * A settings change that would strand work in progress.
 *
 * Separate from `SettingsRejectedError` because nothing here is invalid:
 * the value is a perfectly good setting and the clinic may well want it.
 * The objection is about *timing* — switching triage off while two
 * patients are sitting in the triage queue takes the nurse's screen away
 * from under her. So the answer says who is in the way, and the screen
 * can offer to show them.
 */
export class SettingsChangeBlockedError extends AppError {
  constructor(
    readonly blockers: Array<{ reason: string; detail: string; count: number }>,
  ) {
    super(
      409,
      'settings_change_blocked',
      'Not while people are still there',
      blockers.map((blocker) => blocker.detail).join('; '),
      { blockers },
    );
  }
}
