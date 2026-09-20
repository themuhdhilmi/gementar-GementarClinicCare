import { Transform } from 'class-transformer';
import { IsEmail, IsObject, IsOptional, IsString, Length, MaxLength } from 'class-validator';

// No DTO here carries a tenant id: the tenant comes from the session
// (TEN-R-01). `npm run lint:dto` fails the build if one ever does.

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class UpdateTenantDto {
  @IsOptional() @IsString() @Length(1, 200) @Transform(trim) name?: string;
  @IsOptional() @IsString() @MaxLength(60) @Transform(trim) timezone?: string;
  @IsOptional() @IsString() @MaxLength(40) @Transform(trim) tin?: string;
  @IsOptional() @IsString() @MaxLength(40) @Transform(trim) businessRegNo?: string;
}

/** Shape-checked here, meaning-checked against the settings schema. */
export class PatchSettingsDto {
  @IsObject()
  settings!: Record<string, unknown>;
}

export class CreateBranchDto {
  @IsString()
  @Length(2, 8)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  code!: string;

  @IsString() @Length(1, 200) @Transform(trim) name!: string;

  @IsOptional() @IsString() @MaxLength(200) @Transform(trim) addressLine1?: string;
  @IsOptional() @IsString() @MaxLength(200) @Transform(trim) addressLine2?: string;
  @IsOptional() @IsString() @MaxLength(100) @Transform(trim) city?: string;
  @IsOptional() @IsString() @MaxLength(100) @Transform(trim) state?: string;
  @IsOptional() @IsString() @MaxLength(20) @Transform(trim) postcode?: string;
  @IsOptional() @IsString() @MaxLength(32) @Transform(trim) phone?: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @MaxLength(60) @Transform(trim) licenceNo?: string;
  @IsOptional() @IsString() @MaxLength(60) @Transform(trim) timezone?: string;
  @IsOptional() @IsObject() operatingHours?: Record<string, unknown>;
}

export class UpdateBranchDto {
  @IsOptional() @IsString() @Length(2, 8) code?: string;
  @IsOptional() @IsString() @Length(1, 200) @Transform(trim) name?: string;
  @IsOptional() @IsString() @MaxLength(200) @Transform(trim) addressLine1?: string;
  @IsOptional() @IsString() @MaxLength(200) @Transform(trim) addressLine2?: string;
  @IsOptional() @IsString() @MaxLength(100) @Transform(trim) city?: string;
  @IsOptional() @IsString() @MaxLength(100) @Transform(trim) state?: string;
  @IsOptional() @IsString() @MaxLength(20) @Transform(trim) postcode?: string;
  @IsOptional() @IsString() @MaxLength(32) @Transform(trim) phone?: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @MaxLength(60) @Transform(trim) licenceNo?: string;
  @IsOptional() @IsString() @MaxLength(60) @Transform(trim) timezone?: string;
  @IsOptional() @IsObject() operatingHours?: Record<string, unknown>;
}

export class ReasonDto {
  @IsOptional() @IsString() @MaxLength(500) @Transform(trim) reason?: string;
}

/** TEN-F-10: the text around a printed document. The logo is a file upload. */
export class LetterheadDto {
  @IsOptional() @IsString() @MaxLength(500) @Transform(trim) headerText?: string;
  @IsOptional() @IsString() @MaxLength(500) @Transform(trim) footerText?: string;
}
