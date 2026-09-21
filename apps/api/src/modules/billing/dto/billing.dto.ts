import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { FeeTimeBand, InvoiceStatus } from '../../../generated/prisma/enums.js';

// No DTO here carries a tenant id: the tenant comes from the session
// (TEN-R-01). `npm run lint:dto` fails the build if one ever does.

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class ManualLineDto {
  @IsOptional() @IsUUID() billableItemId?: string;
  @IsOptional() @IsString() @Length(2, 300) @Transform(trim) description?: string;
  @IsNumber() @Min(0) @Max(100_000) quantity!: number;
  /** Ringgit, as typed. Two decimal places at most. */
  @IsOptional() @IsNumber() @Min(0) unitPrice?: number;
  @IsOptional() @IsString() @MaxLength(20) @Transform(trim) taxCode?: string;
}

export class UpdateLineDto {
  @IsOptional() @IsNumber() @Min(0) @Max(100_000) quantity?: number;
  @IsOptional() @IsNumber() @Min(0) unitPrice?: number;
  @IsOptional() @IsString() @Length(2, 300) @Transform(trim) description?: string;
}

export class DiscountDto {
  /** One of these two, never both. */
  @IsOptional() @IsNumber() @Min(0) @Max(100) pct?: number;
  @IsOptional() @IsNumber() @Min(0) amount?: number;
  @IsString() @MaxLength(40) @Transform(trim) source!: string;
  @IsOptional() @IsString() @MaxLength(500) @Transform(trim) reason?: string;
  /** BIL-F-09: the administrator who approved an above-cap discount. */
  @IsOptional() @IsUUID() elevatedBy?: string;
}

export class IssueInvoiceDto {
  @IsOptional() @IsString() @Length(8, 80) @Transform(trim) idempotencyKey?: string;
}

export class VoidInvoiceDto {
  @IsString() @Length(10, 500) @Transform(trim) reason!: string;
}

export class StandaloneInvoiceDto {
  @IsOptional() @IsUUID() patientId?: string;
  @IsOptional() @IsString() @Length(2, 150) @Transform(trim) walkupName?: string;
}

export class InvoiceQueryDto {
  @IsOptional() @IsEnum(InvoiceStatus) status?: InvoiceStatus;
  @IsOptional() @IsUUID() patientId?: string;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
}

export class BillableItemDto {
  @IsOptional() @IsString() @Length(2, 40) @Transform(trim) code?: string;
  @IsString() @Length(2, 200) @Transform(trim) name!: string;
  @IsNumber() @Min(0) defaultPrice!: number;
  @IsOptional() @IsString() @MaxLength(20) @Transform(trim) taxCode?: string;
  @IsOptional() @IsString() @MaxLength(80) @Transform(trim) category?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class FeeScheduleDto {
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsString() @MaxLength(40) @Transform(trim) encounterType?: string;
  @IsOptional() @IsUUID() doctorId?: string;
  @IsOptional() @IsEnum(FeeTimeBand) timeBand?: FeeTimeBand;
  /** Ringgit, as typed. */
  @IsNumber() @Min(0) fee!: number;
  @IsOptional() @IsString() @MaxLength(20) @Transform(trim) taxCode?: string;
  @IsOptional() @IsString() effectiveFrom?: string;
  @IsOptional() @IsString() effectiveTo?: string;
  @IsOptional() @IsInt() @Min(0) @Max(1000) priority?: number;
}
