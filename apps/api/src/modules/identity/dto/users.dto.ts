import { Type, Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Role, UserStatus } from '../../../generated/prisma/enums.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class RoleAssignmentDto {
  @IsString()
  @Length(36, 36)
  branchId!: string;

  @IsEnum(Role)
  role!: Role;
}

export class CreateUserDto {
  @IsString()
  @Length(1, 120)
  @Transform(trim)
  name!: string;

  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(254)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Transform(trim)
  phone?: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Give the user at least one branch and role.' })
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => RoleAssignmentDto)
  roles!: RoleAssignmentDto[];

  @IsOptional()
  @IsString()
  @Length(36, 36)
  defaultBranchId?: string;
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  @Transform(trim)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Transform(trim)
  phone?: string;

  @IsOptional()
  @IsString()
  @Length(36, 36)
  defaultBranchId?: string;
}

export class ReplaceRolesDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'A user needs at least one branch and role.' })
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => RoleAssignmentDto)
  roles!: RoleAssignmentDto[];
}

export class ReasonDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  reason?: string;
}

export class ListUsersQueryDto {
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @IsOptional()
  @IsString()
  @Length(36, 36)
  branchId?: string;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
