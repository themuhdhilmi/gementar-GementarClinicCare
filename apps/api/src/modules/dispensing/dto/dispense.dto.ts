import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { DispenseOutcome } from '../../../generated/prisma/enums.js';

// No DTO here carries a tenant id: the tenant comes from the session
// (TEN-R-01). `npm run lint:dto` fails the build if one ever does.

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class BatchChoiceDto {
  @IsUUID() batchId!: string;
  @IsNumber() @Min(0) @Max(100_000) quantity!: number;
  /** DSP-R-07: required when this is not the batch FEFO suggested. */
  @IsOptional() @IsString() @MaxLength(500) @Transform(trim) overrideReason?: string;
}

export class RegisterDto {
  @IsOptional() @IsUUID() witnessId?: string;
  @IsOptional() @IsString() @MaxLength(150) @Transform(trim) witnessName?: string;
}

export class DispenseItemDto {
  @IsOptional() @IsArray() @ArrayMaxSize(20)
  @ValidateNested({ each: true }) @Type(() => BatchChoiceDto)
  batches?: BatchChoiceDto[];

  @IsOptional() @IsNumber() @Min(0) @Max(100_000) quantity?: number;
  @IsOptional() @IsEnum(DispenseOutcome) outcome?: DispenseOutcome;
  @IsOptional() @IsString() @MaxLength(500) @Transform(trim) reason?: string;
  @IsOptional() @IsBoolean() counselled?: boolean;

  /** DSP-F-11: a retried request returns the original result. */
  @IsOptional() @IsString() @Length(8, 80) @Transform(trim) idempotencyKey?: string;

  @IsOptional() @ValidateNested() @Type(() => RegisterDto) register?: RegisterDto;
}

export class SubstituteDto {
  @IsUUID() productId!: string;
  @IsString() @Length(3, 500) @Transform(trim) reason!: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100_000) quantity?: number;
  @IsOptional() @IsString() @Length(8, 80) @Transform(trim) idempotencyKey?: string;
}

export class DispenseReasonDto {
  @IsString() @Length(3, 500) @Transform(trim) reason!: string;
}

export class ReturnDto {
  @IsNumber() @Min(0) @Max(100_000) quantity!: number;
  @IsString() @Length(3, 500) @Transform(trim) reason!: string;
}

export class CompleteDispenseDto {
  @IsOptional() @IsBoolean() counselled?: boolean;
}

export class CancelDispenseDto {
  @IsOptional() @IsString() @MaxLength(500) @Transform(trim) reason?: string;
}
