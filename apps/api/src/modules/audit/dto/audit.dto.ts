import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// No DTO here carries a tenant id: the tenant comes from the session
// (TEN-R-01). `npm run lint:dto` fails the build if one ever does.

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class AuditSearchDto {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @IsUUID(undefined) actorId?: string;
  @IsOptional() @IsString() @MaxLength(80) @Transform(trim) action?: string;
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Transform(trim)
  actionGroup?: string;
  @IsOptional() @IsString() @MaxLength(60) @Transform(trim) entityType?: string;
  @IsOptional() @IsUUID(undefined) entityId?: string;
  @IsOptional() @IsUUID(undefined) patientId?: string;
  @IsOptional() @IsUUID(undefined) branchId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
  /** Kept so IAM's existing dashboard call still works. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(366) days?: number;
}

export class AccessHistoryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(366) days?: number;
}

export class AuditExportDto {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @IsUUID(undefined) actorId?: string;
  @IsOptional() @IsString() @MaxLength(80) @Transform(trim) action?: string;
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Transform(trim)
  actionGroup?: string;
  @IsOptional() @IsUUID(undefined) patientId?: string;
  @IsOptional() @IsUUID(undefined) branchId?: string;
}
