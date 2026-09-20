import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';

// No DTO here carries a tenant id: the tenant comes from the session
// (TEN-R-01). `npm run lint:dto` fails the build if one ever does.

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * The form's units, not the stored ones.
 *
 * The bounds here are deliberately far wider than any real reading. They
 * exist only to stop a number that would overflow a column; deciding what
 * is *implausible* belongs to the service, which says "a systolic of 1200
 * is not a possible reading, check what was typed" rather than naming a
 * field and a limit. A nurse has to act on the message.
 */
export class TriageDto {
  @IsOptional() @IsInt() @Min(0) @Max(32_000) systolic?: number;
  @IsOptional() @IsInt() @Min(0) @Max(32_000) diastolic?: number;
  @IsOptional() @IsInt() @Min(0) @Max(32_000) heartRate?: number;
  @IsOptional() @IsInt() @Min(0) @Max(32_000) respRate?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 1 }) @Min(0) @Max(3000) temperature?: number;
  @IsOptional() @IsInt() @Min(0) @Max(32_000) spo2?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 1 }) @Min(0) @Max(2_000_000) weightKg?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 1 }) @Min(0) @Max(3000) heightCm?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 1 }) @Min(0) @Max(3000) glucose?: number;
  @IsOptional() @IsBoolean() glucoseFasting?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(32_000) painScore?: number;
  @IsOptional() @IsString() @MaxLength(1000) @Transform(trim) complaint?: string;
  @IsOptional() @IsString() @MaxLength(1000) @Transform(trim) notes?: string;

  /** Send the patient on to the doctor. Default true. */
  @IsOptional() @IsBoolean() advance?: boolean;
  /** Act on a critical reading by moving them to the front of the queue. */
  @IsOptional() @IsBoolean() escalate?: boolean;
}

export class AmendTriageDto extends TriageDto {
  @IsString() @Length(3, 500) @Transform(trim) reason!: string;
}
