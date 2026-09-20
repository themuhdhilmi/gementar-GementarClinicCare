import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';
import {
  EncounterPriority,
  EncounterStatus,
  EncounterType,
  RoomType,
} from '../../../generated/prisma/enums.js';

// No DTO here carries a tenant id: the tenant comes from the session
// (TEN-R-01). `npm run lint:dto` fails the build if one ever does.

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CheckInDto {
  @IsUUID() patientId!: string;
  @IsOptional() @IsEnum(EncounterType) type?: EncounterType;
  @IsOptional() @IsEnum(EncounterPriority) priority?: EncounterPriority;
  @IsOptional() @IsString() @MaxLength(300) @Transform(trim) priorityReason?: string;
  @IsOptional() @IsUUID() attendingDoctorId?: string;
  @IsOptional() @IsUUID() roomId?: string;
}

export class TransitionDto {
  @IsEnum(EncounterStatus) to!: EncounterStatus;
  @IsOptional() @IsString() @MaxLength(500) @Transform(trim) note?: string;
}

export class ReasonDto {
  @IsString() @Length(3, 500) @Transform(trim) reason!: string;
}

export class PriorityDto {
  @IsEnum(EncounterPriority) priority!: EncounterPriority;
  @IsOptional() @IsString() @MaxLength(300) @Transform(trim) reason?: string;
}

export class AssignmentDto {
  /** Explicit null means "any available doctor", which is a real answer. */
  @IsOptional() @IsUUID() attendingDoctorId?: string | null;
  @IsOptional() @IsUUID() roomId?: string | null;
  @IsOptional() @IsString() @MaxLength(300) @Transform(trim) reason?: string;
}

export class FollowUpDto {
  @IsOptional() @IsISO8601() followUpDue?: string;
  @IsOptional() @IsString() @MaxLength(500) @Transform(trim) followUpNote?: string;
}

export class RoomDto {
  @IsString() @Length(1, 60) @Transform(trim) name!: string;
  @IsString() @Length(1, 16) @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  code!: string;
  @IsOptional() @IsEnum(RoomType) type?: RoomType;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class DisplayTokenDto {
  @IsString() @Length(1, 80) @Transform(trim) label!: string;
}
