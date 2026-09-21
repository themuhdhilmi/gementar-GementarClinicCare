import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  CashMovementType,
  PaymentMethod,
} from '../../../generated/prisma/enums.js';

// No DTO here carries a tenant id: the tenant comes from the session
// (TEN-R-01). `npm run lint:dto` fails the build if one ever does.

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class OpenSessionDto {
  /** Ringgit, as typed. */
  @IsNumber() @Min(0) @Max(1_000_000) float!: number;
  @IsOptional() @IsString() @Length(1, 20) @Transform(trim) drawerCode?: string;
}

export class MovementDto {
  @IsEnum(CashMovementType) type!: CashMovementType;
  @IsNumber() @Min(0.01) @Max(1_000_000) amount!: number;
  @IsString() @Length(3, 500) @Transform(trim) reason!: string;
}

export class CloseSessionDto {
  @IsNumber() @Min(0) @Max(1_000_000) counted!: number;
  /** `{ "100": 3, "50": 2, "0.10": 14 }` — optional, and only a helper. */
  @IsOptional() @IsObject() denominations?: Record<string, number>;
  @IsOptional() @IsString() @MaxLength(500) @Transform(trim) note?: string;
  /** An administrator saying, deliberately, that this variance is accepted. */
  @IsOptional() @IsBoolean() approve?: boolean;
}

export class ReopenSessionDto {
  @IsString() @Length(10, 500) @Transform(trim) reason!: string;
}

export class PaymentPreviewDto {
  @IsEnum(PaymentMethod) method!: PaymentMethod;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000) amount?: number;
}

export class TakePaymentDto {
  @IsEnum(PaymentMethod) method!: PaymentMethod;
  /** Ringgit, as typed. Leave it out to settle the remaining balance. */
  @IsOptional() @IsNumber() @Min(0.01) @Max(1_000_000) amount?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000) tendered?: number;
  @IsOptional() @IsString() @MaxLength(120) @Transform(trim) reference?: string;
  @IsOptional() @IsString() @MaxLength(40) @Transform(trim) cardBrand?: string;
  @IsOptional() @IsString() @Length(1, 20) @Transform(trim) drawerCode?: string;
  /** PAY-F-11. The browser generates one per attempt, not per retry. */
  @IsString() @Length(8, 80) @Transform(trim) idempotencyKey!: string;
}

export class VoidPaymentDto {
  @IsString() @Length(10, 500) @Transform(trim) reason!: string;
}

export class RefundDto {
  @IsNumber() @Min(0.01) @Max(1_000_000) amount!: number;
  @IsEnum(PaymentMethod) method!: PaymentMethod;
  @IsString() @Length(10, 500) @Transform(trim) reason!: string;
  @IsOptional() @IsUUID(undefined) refundOfId?: string;
  @IsOptional() @IsString() @Length(1, 20) @Transform(trim) drawerCode?: string;
  @IsString() @Length(8, 80) @Transform(trim) idempotencyKey!: string;
}

export class SessionQueryDto {
  @IsOptional() @IsString() @Length(1, 20) @Transform(trim) drawerCode?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(366) days?: number;
}

export class PaymentMethodConfigDto {
  @IsEnum(PaymentMethod) method!: PaymentMethod;
  @IsBoolean() enabled!: boolean;
  @IsOptional() @IsBoolean() requiresReference?: boolean;
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Transform(trim)
  displayName?: string;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  sortOrder?: number;
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Transform(trim)
  qrPayload?: string;
}
