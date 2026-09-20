import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
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

// No DTO here carries a tenant id: the tenant comes from the session
// (TEN-R-01). `npm run lint:dto` fails the build if one ever does.

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * The bounds here are overflow guards, not clinical judgement. The
 * service decides what is a sensible dose and says so in words; a DTO
 * rejecting 400 days with "durationDays must not be greater than 365"
 * would pre-empt a better message with a worse one.
 */
export class PrescriptionItemDto {
  @IsOptional() @IsUUID() productId?: string;
  @IsOptional() @IsString() @MaxLength(200) @Transform(trim) externalName?: string;

  @IsNumber() @Min(0) @Max(100_000) doseValue!: number;
  @IsString() @MaxLength(20) @Transform(trim) doseUnit!: string;
  @IsString() @MaxLength(20) @Transform(trim) route!: string;
  @IsString() @MaxLength(20) @Transform(trim) frequencyCode!: string;
  @IsOptional() @IsNumber() @Min(0) @Max(48) frequencyPerDay?: number;

  @IsOptional() @IsBoolean() isPrn?: boolean;
  @IsOptional() @IsString() @MaxLength(200) @Transform(trim) prnIndication?: string;

  @IsOptional() @IsInt() @Min(0) @Max(3650) durationDays?: number;
  @IsOptional() @IsBoolean() untilFinished?: boolean;

  /** Omit to take the calculated quantity (RX-T-05). */
  @IsOptional() @IsNumber() @Min(0) @Max(100_000) quantity?: number;

  @IsOptional() @IsString() @MaxLength(500) @Transform(trim) instructions?: string;
}

export class OverrideDto {
  @IsString() @Length(5, 500) @Transform(trim) reason!: string;
  /**
   * "The allergy record is wrong" is a claim about the record. Given this,
   * the record is corrected rather than overridden again next visit.
   */
  @IsOptional() @IsUUID() refuteAllergyId?: string;
}

export class AmendItemDto {
  @IsString() @Length(5, 500) @Transform(trim) reason!: string;
  @ValidateNested() @Type(() => PrescriptionItemDto) item!: PrescriptionItemDto;
}

export class ReasonDto {
  @IsString() @Length(5, 500) @Transform(trim) reason!: string;
}

export class DeclineDto {
  @IsOptional() @IsString() @MaxLength(500) @Transform(trim) reason?: string;
}

export class CheckDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => PrescriptionItemDto)
  items!: PrescriptionItemDto[];
}

export class PrescriptionNotesDto {
  @IsOptional() @IsString() @MaxLength(1000) @Transform(trim) notesToDispenser?: string;
  /** MS or EN. RX-Q-02 is open on whether more are needed. */
  @IsOptional() @IsString() @Length(2, 2) @Transform(trim) language?: string;
}
