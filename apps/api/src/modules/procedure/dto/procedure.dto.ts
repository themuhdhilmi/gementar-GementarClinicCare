import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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
  ValidateNested,
} from 'class-validator';
import { Laterality, ProcedureCategory } from '../../../generated/prisma/enums.js';

// No DTO here carries a tenant id: the tenant comes from the session
// (TEN-R-01). `npm run lint:dto` fails the build if one ever does.

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class ProcedureConsumableDto {
  @IsUUID() productId!: string;
  @IsNumber() @Min(0) @Max(10_000) quantity!: number;
  @IsOptional() @IsBoolean() optional?: boolean;
}

export class ProcedureDto {
  @IsOptional() @IsString() @Length(2, 40) @Transform(trim) code?: string;
  @IsString() @Length(2, 160) @Transform(trim) name!: string;
  @IsEnum(ProcedureCategory) category!: ProcedureCategory;
  /** Ringgit, as typed. */
  @IsNumber() @Min(0) price!: number;
  @IsOptional() @IsBoolean() requiresConsent?: boolean;
  @IsOptional() @IsBoolean() requiresDoctor?: boolean;
  @IsOptional() @IsUUID() vaccineProductId?: string;
  @IsOptional() @IsInt() @Min(1) @Max(600) defaultDurationMin?: number;
  @IsOptional() @IsString() @MaxLength(4000) @Transform(trim) protocol?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(30)
  @ValidateNested({ each: true }) @Type(() => ProcedureConsumableDto)
  consumables?: ProcedureConsumableDto[];
}

export class UpdateProcedureDto extends ProcedureDto {
  @IsOptional() @IsString() @Length(2, 160) @Transform(trim) declare name: string;
  @IsOptional() @IsEnum(ProcedureCategory) declare category: ProcedureCategory;
  @IsOptional() @IsNumber() @Min(0) declare price: number;
  @IsOptional() @IsString() @MaxLength(500) @Transform(trim) priceReason?: string;
}

export class OrderProcedureDto {
  @IsUUID() procedureId!: string;
  @IsOptional() @IsUUID() consultationId?: string;
  /** Two dressings is two orders, so it is charged twice. */
  @IsOptional() @IsInt() @Min(1) @Max(20) quantity?: number;
}

export class PerformConsumableDto {
  @IsUUID() productId!: string;
  /** Omit and FEFO chooses. */
  @IsOptional() @IsUUID() batchId?: string;
  @IsNumber() @Min(0) @Max(10_000) quantity!: number;
}

export class PerformDto {
  @IsOptional() @IsArray() @ArrayMaxSize(30)
  @ValidateNested({ each: true }) @Type(() => PerformConsumableDto)
  consumables?: PerformConsumableDto[];

  @IsOptional() @IsString() @MaxLength(120) @Transform(trim) site?: string;
  @IsOptional() @IsEnum(Laterality) laterality?: Laterality;
  @IsOptional() @IsBoolean() consentGiven?: boolean;
  @IsOptional() @IsString() @MaxLength(160) @Transform(trim) consentBy?: string;
  @IsOptional() @IsString() @MaxLength(2000) @Transform(trim) notes?: string;
  @IsOptional() @IsString() @MaxLength(2000) @Transform(trim) complications?: string;
  @IsOptional() @IsInt() @Min(1) @Max(20) doseNumber?: number;
  /** Used from stock nobody had entered. Recorded, and flagged. */
  @IsOptional() @IsBoolean() allowShortfall?: boolean;
}

export class ProcedureReasonDto {
  @IsString() @Length(3, 500) @Transform(trim) reason!: string;
}

export class VoidProcedureDto {
  @IsString() @Length(10, 500) @Transform(trim) reason!: string;
}
