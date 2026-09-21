/** Audit action names are a stable contract; renaming one is a breaking change. */
export const AuditAction = {
  UserCreated: 'user.created',
  UserUpdated: 'user.updated',
  UserDisabled: 'user.disabled',
  UserEnabled: 'user.enabled',
  UserUnlocked: 'user.unlocked',
  UserRoleChanged: 'user.role_changed',
  UserPasswordForceReset: 'user.password_force_reset',
  UserMfaReset: 'user.mfa_reset',
  AuthLogin: 'auth.login',
  AuthLoginFailed: 'auth.login_failed',
  AuthLogout: 'auth.logout',
  AuthLocked: 'auth.locked',
  AuthReauth: 'auth.reauth',
  AuthPasswordChanged: 'auth.password_changed',
  AuthPasswordReset: 'auth.password_reset',
  AuthPasswordResetRequested: 'auth.password_reset_requested',
  AuthBranchSwitched: 'auth.branch_switched',
  SessionRevoked: 'session.revoked',
  MfaEnrolled: 'mfa.enrolled',
  MfaDisabled: 'mfa.disabled',
  MfaRecoveryUsed: 'mfa.recovery_used',
  MfaFailed: 'mfa.failed',
  TrustedDeviceAdded: 'device.trusted',
  TrustedDeviceRevoked: 'device.revoked',
  BreakGlass: 'audit.break_glass',
  BranchCreated: 'branch.created',
  BranchUpdated: 'branch.updated',
  BranchDeactivated: 'branch.deactivated',
  BranchActivated: 'branch.activated',
  TenantCreated: 'tenant.created',
  TenantSuspended: 'tenant.suspended',
  TenantResumed: 'tenant.resumed',
  TenantPlanChanged: 'tenant.plan_changed',
  TenantModulesChanged: 'tenant.modules_changed',
  TenantUpdated: 'tenant.updated',
  TenantSettingsChanged: 'tenant.settings_changed',
  BranchSettingsChanged: 'branch.settings_changed',

  // Patient registry (PAT, v0-03).
  PatientRegistered: 'patient.registered',
  PatientUpdated: 'patient.updated',
  PatientMerged: 'patient.merged',
  PatientUnmerged: 'patient.unmerged',
  PatientDeleted: 'patient.deleted',
  PatientIdUnmasked: 'patient.id_unmasked',
  PatientExported: 'patient.exported',
  PatientImported: 'patient.imported',
  PatientAllergyAdded: 'patient.allergy_added',
  PatientAllergyVerified: 'patient.allergy_verified',
  PatientAllergyRefuted: 'patient.allergy_refuted',
  PatientNkdaRecorded: 'patient.nkda_recorded',
  PatientConditionChanged: 'patient.condition_changed',
  PatientConsentChanged: 'patient.consent_changed',
  PatientContactChanged: 'patient.contact_changed',
  PatientDocumentAdded: 'patient.document_added',
  PatientDocumentViewed: 'patient.document_viewed',
  PatientDocumentDeleted: 'patient.document_deleted',
  ClinicalViewed: 'clinical.viewed',

  // Encounter and queue (ENC, v0-04).
  EncounterCreated: 'encounter.created',
  EncounterStatusChanged: 'encounter.status_changed',
  EncounterCalled: 'encounter.called',
  EncounterSkipped: 'encounter.skipped',
  EncounterPriorityChanged: 'encounter.priority_changed',
  EncounterReassigned: 'encounter.reassigned',
  EncounterCancelled: 'encounter.cancelled',
  EncounterNoShow: 'encounter.no_show',
  EncounterReopened: 'encounter.reopened',
  /// Loud on purpose: an administrator overriding the state machine.
  EncounterForced: 'encounter.force_transition',
  DisplayTokenIssued: 'display_token.issued',
  DisplayTokenRevoked: 'display_token.revoked',
  BranchRoomChanged: 'branch_room.changed',

  // Triage (TRI, v0-05).
  TriageRecorded: 'triage.recorded',
  TriageAmended: 'triage.amended',

  // Consultation (CON, v0-06).
  ConsultationCreated: 'consultation.created',
  ConsultationSigned: 'consultation.signed',
  ConsultationAmended: 'consultation.amended',
  ConsultationCancelled: 'consultation.cancelled',
  ConsultationReassigned: 'consultation.reassigned',
  TemplateUsed: 'template.used',

  // Product catalogue (INV, v0-09 first half).
  ProductCreated: 'product.created',
  ProductUpdated: 'product.updated',
  ProductRetired: 'product.retired',
  ProductImported: 'product.imported',
  BranchLetterheadChanged: 'branch.letterhead_changed',

  // Prescription (RX, v0-07).
  PrescriptionItemAdded: 'prescription.item_added',
  PrescriptionItemUpdated: 'prescription.item_updated',
  PrescriptionItemRemoved: 'prescription.item_removed',
  PrescriptionActivated: 'prescription.activated',
  PrescriptionCancelled: 'prescription.cancelled',
  PrescriptionItemAmended: 'prescription.item_amended',
  PrescriptionItemCancelled: 'prescription.item_cancelled',
  PrescriptionItemDeclined: 'prescription.item_declined',
  /// RX-R-05: carries the full warning payload and the reason given.
  PrescriptionWarningOverridden: 'prescription.warning_overridden',
  /// Lighter than clinical.viewed — the dispenser sees far less (RX-R-10).
  PrescriptionDispenseViewed: 'rx.dispense_viewed',

  // Stock (INV, v0-09 second half).
  StockReceived: 'stock.received',
  StockOpeningPosted: 'stock.opening_posted',
  StockAdjusted: 'stock.adjusted',
  StockExpiryWrittenOff: 'stock.expiry_written_off',
  BatchBlocked: 'batch.blocked',
  StockCountOpened: 'stock.count_opened',
  StockCountSubmitted: 'stock.count_submitted',
  StockCountApproved: 'stock.count_approved',
  StockCountCancelled: 'stock.count_cancelled',
  StockQuarantineReleased: 'stock.quarantine_released',
  StockAlertAcknowledged: 'stock.alert_acknowledged',

  // Procedures (PRC, v0-10).
  ProcedureCreated: 'procedure.catalogue_created',
  ProcedureUpdated: 'procedure.catalogue_updated',
  ProcedureRetired: 'procedure.catalogue_retired',
  ProcedureOrdered: 'procedure.ordered',
  ProcedurePerformed: 'procedure.performed',
  ProcedureCancelled: 'procedure.cancelled',
  /// Loud: it reverses stock and removes a charge.
  ProcedureVoided: 'procedure.voided',
  VaccinationRecorded: 'vaccination.recorded',

  // Dispensing (DSP, v0-08).
  DispenseOpened: 'dispense.opened',
  DispenseItemDispensed: 'dispense.item_dispensed',
  DispenseItemSubstituted: 'dispense.item_substituted',
  DispenseItemExternal: 'dispense.item_external',
  DispenseItemDeclined: 'dispense.item_declined',
  DispenseUndone: 'dispense.undone',
  DispenseReturned: 'dispense.returned',
  DispenseCompleted: 'dispense.session_completed',
  DispenseCancelled: 'dispense.cancelled',
  LabelReprinted: 'dispense.label_reprinted',
  /// The register is a legal document; reading it shows unmasked ICs.
  ControlledRegisterViewed: 'controlled_register.viewed',
  ControlledDispensed: 'controlled.dispensed',

  // Documents (DOC, v0-13).
  DocumentIssued: 'document.issued',
  DocumentReprinted: 'document.reprinted',
  DocumentCancelled: 'document.cancelled',
  DoctorSignatureUploaded: 'document.signature_uploaded',

  // Billing (BIL, v0-11).
  InvoiceDraftCreated: 'invoice.draft_created',
  InvoiceLineAdded: 'invoice.manual_line_added',
  InvoiceLineEdited: 'invoice.manual_line_edited',
  InvoiceLineRemoved: 'invoice.manual_line_removed',
  InvoiceDiscounted: 'invoice.discounted',
  InvoiceIssued: 'invoice.issued',
  InvoiceVoided: 'invoice.voided',
  InvoiceReissued: 'invoice.reissued',
  InvoiceReprinted: 'invoice.reprinted',
  FeeScheduleChanged: 'billing.fee_schedule_changed',
  BillableItemChanged: 'billing.billable_item_changed',
  CatalogueChanged: 'catalogue.changed',
  TemplateChanged: 'template.changed',
  EncounterFollowUpSet: 'encounter.follow_up_set',
  StockCountImported: 'stock.count_imported',
  StockReconciled: 'stock.reconciled',
  AuditExported: 'audit.exported',
  ReportExported: 'report.exported',
  EodPackGenerated: 'eod_pack.generated',
  CashSessionOpened: 'cash_session.opened',
  CashSessionClosed: 'eod.closed',
  CashSessionReopened: 'cash_session.reopened',
  CashMovementRecorded: 'cash_session.movement',
  PaymentReceived: 'payment.received',
  PaymentVoided: 'payment.voided',
  PaymentRefunded: 'payment.refunded',
  ReceiptReprinted: 'receipt.reprinted',
  PaymentMethodsChanged: 'payment.methods_changed',
} as const;

export type AuditActionName = (typeof AuditAction)[keyof typeof AuditAction];

/**
 * AUD §12: an action is valid only if it is in this catalogue.
 *
 * Used by the audit search to reject a filter for an action nobody
 * emits — which would otherwise return nothing and read as "it never
 * happened" rather than "you asked for something that does not exist" —
 * and by `npm run lint:audited` to check what routes declare.
 */
export const AUDIT_ACTION_SET: ReadonlySet<string> = new Set(
  Object.values(AuditAction),
);

/** The groups the audit screen filters by (AUD §10). */
export const AUDIT_ACTION_GROUPS: Record<string, readonly string[]> = {
  access: ['auth.', 'session.', 'mfa.'],
  users: ['user.'],
  tenant: ['branch.', 'tenant.', 'admin.'],
  clinical: [
    'clinical.',
    'consultation.',
    'prescription.',
    'triage.',
    'procedure.',
  ],
  patient: ['patient.'],
  stock: ['stock.', 'catalogue.', 'dispense.', 'count.'],
  money: ['invoice.', 'payment.', 'billing.', 'eod.'],
  documents: ['document.', 'doctor_signature.'],
  meta: ['audit.'],
};
