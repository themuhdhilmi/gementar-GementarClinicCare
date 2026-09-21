import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { DocumentType } from '../../../generated/prisma/enums.js';

// No DTO here carries a tenant id: the tenant comes from the session
// (TEN-R-01). `npm run lint:dto` fails the build if one ever does.

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class McDto {
  /** `YYYY-MM-DD`. Defaults to today. */
  @IsOptional() @IsString() @Length(10, 10) @Transform(trim) fromDate?: string;
  @IsInt() @Min(1) @Max(365) days!: number;
  @IsOptional() @IsBoolean() lightDuty?: boolean;
  /** Off by default: a certificate is shown to an employer. */
  @IsOptional() @IsBoolean() includeDiagnosis?: boolean;
  @IsOptional() @IsString() @Length(2, 2) @Transform(trim) language?: string;
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  backdateReason?: string;
}

export class ReferralDto {
  @IsString() @Length(2, 200) @Transform(trim) to!: string;
  @IsString() @Length(2, 2000) @Transform(trim) reason!: string;
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  @Transform(trim)
  summary?: string;
  @IsOptional() @IsString() @MaxLength(20) @Transform(trim) urgency?: string;
}

export class LetterDto {
  @IsOptional() @IsString() @Length(2, 120) @Transform(trim) title?: string;
  @IsString() @Length(2, 10_000) @Transform(trim) body!: string;
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Transform(trim)
  billableItemCode?: string;
}

export class CancelDocumentDto {
  @IsString() @Length(10, 500) @Transform(trim) reason!: string;
}

export class DocumentQueryDto {
  @IsOptional() @IsEnum(DocumentType) type?: DocumentType;
}
