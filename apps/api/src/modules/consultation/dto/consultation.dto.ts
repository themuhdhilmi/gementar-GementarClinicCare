import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  AmendmentType,
  DiagnosisCertainty,
  DiagnosisRank,
  TemplateScope,
} from '../../../generated/prisma/enums.js';

// No DTO here carries a tenant id: the tenant comes from the session
// (TEN-R-01). `npm run lint:dto` fails the build if one ever does.

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class StartConsultationDto {
  /** CON-F-06: bring the history sections forward from an earlier visit. */
  @IsOptional() @IsUUID() copyFromId?: string;
}

/** Every section is optional: this is an autosave of whatever exists. */
export class SaveConsultationDto {
  @IsOptional() @IsString() @MaxLength(20_000) chiefComplaint?: string;
  @IsOptional() @IsString() @MaxLength(20_000) hpi?: string;
  @IsOptional() @IsString() @MaxLength(20_000) history?: string;
  @IsOptional() @IsString() @MaxLength(20_000) examination?: string;
  @IsOptional() @IsString() @MaxLength(20_000) planText?: string;
  @IsOptional() @IsISO8601() followUpDue?: string;
  @IsOptional() @IsString() @MaxLength(500) @Transform(trim) followUpNote?: string;
}

export class DiagnosisDto {
  @IsOptional() @IsEnum(DiagnosisRank) rank?: DiagnosisRank;
  @IsString() @Length(2, 200) @Transform(trim) description!: string;
  @IsOptional() @IsString() @MaxLength(10) @Transform(trim) icd10Code?: string;
  @IsOptional() @IsString() @MaxLength(300) @Transform(trim) icd10Label?: string;
  @IsOptional() @IsEnum(DiagnosisCertainty) certainty?: DiagnosisCertainty;
  @IsOptional() @IsBoolean() isChronic?: boolean;
}

export class DiagnosesDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => DiagnosisDto)
  diagnoses!: DiagnosisDto[];
}

/**
 * RX-R-04: the second, explicit yes to a severe allergy warning. Named
 * per item, so ticking a box for one drug does not tick it for another
 * that was added after the doctor read the screen.
 */
export class SignDto {
  @IsOptional() @IsArray() @IsUUID(undefined, { each: true }) confirm?: string[];
}

export class ReasonDto {
  @IsString() @Length(3, 500) @Transform(trim) reason!: string;
}

export class AmendDto {
  @IsEnum(AmendmentType) type!: AmendmentType;
  @IsOptional() @IsString() @MaxLength(40) field?: string;
  @IsString() @Length(1, 20_000) current!: string;
  /** CON-R-04: ten characters, because "typo" explains nothing later. */
  @IsString() @Length(10, 1000) @Transform(trim) reason!: string;
}

export class ReassignDto {
  @IsUUID() toDoctorId!: string;
  @IsString() @Length(3, 500) @Transform(trim) reason!: string;
}

export class TemplateContentDto {
  @IsOptional() @IsString() @MaxLength(20_000) chiefComplaint?: string;
  @IsOptional() @IsString() @MaxLength(20_000) hpi?: string;
  @IsOptional() @IsString() @MaxLength(20_000) history?: string;
  @IsOptional() @IsString() @MaxLength(20_000) examination?: string;
  @IsOptional() @IsString() @MaxLength(20_000) planText?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => DiagnosisDto)
  diagnoses?: DiagnosisDto[];
}

export class TemplateDto {
  @IsString() @Length(2, 120) @Transform(trim) name!: string;
  @IsOptional() @IsArray() @IsString({ each: true }) keywords?: string[];
  @ValidateNested() @Type(() => TemplateContentDto) content!: TemplateContentDto;
  @IsOptional() @IsEnum(TemplateScope) scope?: TemplateScope;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateTemplateDto {
  @IsOptional() @IsString() @Length(2, 120) @Transform(trim) name?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) keywords?: string[];
  @IsOptional() @ValidateNested() @Type(() => TemplateContentDto) content?: TemplateContentDto;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class QuickPhraseDto {
  @IsString() @Length(2, 40) @Transform(trim) trigger!: string;
  @IsString() @Length(1, 1000) expansion!: string;
}
