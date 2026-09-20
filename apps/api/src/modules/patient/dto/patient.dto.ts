import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  AllergySeverity,
  AllergyType,
  BloodGroup,
  ConditionStatus,
  ConsentChannel,
  ConsentPurpose,
  Gender,
  IdType,
  MaritalStatus,
  PatientDocumentType,
} from '../../../generated/prisma/enums.js';

// No DTO here carries a tenant id: the tenant comes from the session
// (TEN-R-01). `npm run lint:dto` fails the build if one ever does.

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * PAT-N-06: the search text may be an identity number, so it travels in a
 * request body rather than a query string. A query string is written to
 * access logs, browser history and any proxy in between, and §8's `GET
 * /patients/search?q=` cannot be reconciled with that.
 */
export class SearchDto {
  @IsString() @MaxLength(120) @Transform(trim) q!: string;
}

export class PatientBodyDto {
  @IsString() @Length(2, 150) @Transform(trim) name!: string;
  @IsEnum(IdType) idType!: IdType;
  @IsOptional() @IsString() @MaxLength(40) @Transform(trim) idNumber?: string;
  @IsOptional() @IsString() @Length(2, 2) passportCountry?: string;
  @IsOptional() @IsISO8601() passportExpiry?: string;
  @IsOptional() @IsISO8601() dateOfBirth?: string;
  @IsOptional() @IsBoolean() dobEstimated?: boolean;
  @IsEnum(Gender) gender!: Gender;
  @IsOptional() @IsString() @Length(2, 2) nationality?: string;
  @IsOptional() @IsString() @MaxLength(60) @Transform(trim) race?: string;
  @IsOptional() @IsString() @MaxLength(60) @Transform(trim) religion?: string;
  @IsOptional() @IsEnum(MaritalStatus) maritalStatus?: MaritalStatus;
  @IsOptional() @IsString() @MaxLength(120) @Transform(trim) occupation?: string;
  @IsOptional() @IsString() @MaxLength(8) preferredLanguage?: string;
  @IsOptional() @IsString() @MaxLength(24) @Transform(trim) phone?: string;
  @IsOptional() @IsString() @MaxLength(24) @Transform(trim) phoneAlt?: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @MaxLength(200) @Transform(trim) addressLine1?: string;
  @IsOptional() @IsString() @MaxLength(200) @Transform(trim) addressLine2?: string;
  @IsOptional() @IsString() @MaxLength(20) @Transform(trim) postcode?: string;
  @IsOptional() @IsString() @MaxLength(100) @Transform(trim) city?: string;
  @IsOptional() @IsString() @MaxLength(100) @Transform(trim) state?: string;
  @IsOptional() @IsEnum(BloodGroup) bloodGroup?: BloodGroup;
  @IsOptional() @IsString() @MaxLength(1000) @Transform(trim) notes?: string;
}

/** Every field optional, and a reason when the identity document changes. */
export class UpdatePatientDto {
  @IsOptional() @IsString() @Length(2, 150) @Transform(trim) name?: string;
  @IsOptional() @IsEnum(IdType) idType?: IdType;
  @IsOptional() @IsString() @MaxLength(40) @Transform(trim) idNumber?: string;
  @IsOptional() @IsString() @Length(2, 2) passportCountry?: string;
  @IsOptional() @IsISO8601() passportExpiry?: string;
  @IsOptional() @IsISO8601() dateOfBirth?: string;
  @IsOptional() @IsBoolean() dobEstimated?: boolean;
  @IsOptional() @IsEnum(Gender) gender?: Gender;
  @IsOptional() @IsString() @Length(2, 2) nationality?: string;
  @IsOptional() @IsString() @MaxLength(60) @Transform(trim) race?: string;
  @IsOptional() @IsString() @MaxLength(60) @Transform(trim) religion?: string;
  @IsOptional() @IsEnum(MaritalStatus) maritalStatus?: MaritalStatus;
  @IsOptional() @IsString() @MaxLength(120) @Transform(trim) occupation?: string;
  @IsOptional() @IsString() @MaxLength(8) preferredLanguage?: string;
  @IsOptional() @IsString() @MaxLength(24) @Transform(trim) phone?: string;
  @IsOptional() @IsString() @MaxLength(24) @Transform(trim) phoneAlt?: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @MaxLength(200) @Transform(trim) addressLine1?: string;
  @IsOptional() @IsString() @MaxLength(200) @Transform(trim) addressLine2?: string;
  @IsOptional() @IsString() @MaxLength(20) @Transform(trim) postcode?: string;
  @IsOptional() @IsString() @MaxLength(100) @Transform(trim) city?: string;
  @IsOptional() @IsString() @MaxLength(100) @Transform(trim) state?: string;
  @IsOptional() @IsEnum(BloodGroup) bloodGroup?: BloodGroup;
  @IsOptional() @IsString() @MaxLength(1000) @Transform(trim) notes?: string;
  @IsOptional() @IsString() @MaxLength(500) @Transform(trim) reason?: string;
}

export class AllergyDto {
  @IsEnum(AllergyType) type!: AllergyType;
  @IsString() @Length(2, 120) @Transform(trim) substance!: string;
  @IsOptional() @IsUUID() productId?: string;
  @IsOptional() @IsString() @MaxLength(120) @Transform(trim) drugClass?: string;
  @IsOptional() @IsString() @MaxLength(300) @Transform(trim) reaction?: string;
  @IsOptional() @IsEnum(AllergySeverity) severity?: AllergySeverity;
  @IsOptional() @IsString() @MaxLength(500) @Transform(trim) notes?: string;
}

export class ReasonBodyDto {
  @IsString() @Length(1, 500) @Transform(trim) reason!: string;
}

export class NkdaDto {
  @IsBoolean() nkda!: boolean;
}

export class ConditionDto {
  @IsString() @Length(2, 200) @Transform(trim) condition!: string;
  @IsOptional() @IsString() @MaxLength(10) @Transform(trim) icd10Code?: string;
  @IsOptional() @IsISO8601() onsetDate?: string;
  @IsOptional() @IsEnum(ConditionStatus) status?: ConditionStatus;
  @IsOptional() @IsString() @MaxLength(500) @Transform(trim) notes?: string;
}

export class ContactDto {
  @IsString() @Length(2, 150) @Transform(trim) name!: string;
  @IsOptional() @IsString() @MaxLength(60) @Transform(trim) relationship?: string;
  @IsString() @MaxLength(24) @Transform(trim) phone!: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
}

export class UpdateContactDto {
  @IsOptional() @IsString() @Length(2, 150) @Transform(trim) name?: string;
  @IsOptional() @IsString() @MaxLength(60) @Transform(trim) relationship?: string;
  @IsOptional() @IsString() @MaxLength(24) @Transform(trim) phone?: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
}

export class ConsentEntryDto {
  @IsEnum(ConsentChannel) channel!: ConsentChannel;
  @IsEnum(ConsentPurpose) purpose!: ConsentPurpose;
  @IsBoolean() granted!: boolean;
}

export class ConsentsDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => ConsentEntryDto)
  consents!: ConsentEntryDto[];
}

export class DocumentTypeDto {
  @IsEnum(PatientDocumentType) type!: PatientDocumentType;
}

export class MergeDto {
  @IsUUID() loserId!: string;
}

export class ImportOptionsDto {
  @IsOptional() @IsBoolean() dryRun?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(1_000_000) startMrnAt?: number;
}
