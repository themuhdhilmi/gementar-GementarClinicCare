import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

// No DTO in this module carries a tenant id: the tenant comes from the session
// (IAM-R-01). `npm run lint:dto` fails the build if one ever does.

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class LoginDto {
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(254)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  email!: string;

  @IsString()
  @Length(1, 256)
  password!: string;

  /** Only needed when one address exists at more than one clinic. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Transform(trim)
  tenantSlug?: string;
}

export class MfaVerifyDto {
  @IsString()
  @Length(6, 20)
  @Transform(trim)
  code!: string;

  @IsOptional()
  @IsBoolean()
  trustDevice?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  deviceLabel?: string;
}

export class MfaConfirmDto {
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code from your authenticator app.' })
  code!: string;
}

export class ForgotPasswordDto {
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(254)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  email!: string;
}

export class ResetPasswordDto {
  @IsString()
  @Length(10, 200)
  token!: string;

  @IsString()
  @MinLength(12, { message: 'Use at least 12 characters.' })
  @MaxLength(128)
  password!: string;
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(12, { message: 'Use at least 12 characters.' })
  @MaxLength(128)
  password!: string;
}

export class ReauthDto {
  @IsOptional()
  @IsString()
  @Length(1, 256)
  password?: string;

  @IsOptional()
  @IsString()
  @Length(6, 20)
  @Transform(trim)
  code?: string;
}

export class SwitchBranchDto {
  @IsString()
  @Length(36, 36)
  branchId!: string;
}
