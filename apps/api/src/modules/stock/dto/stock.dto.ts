import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
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
import { StockMovementType } from '../../../generated/prisma/enums.js';

// No DTO here carries a tenant id: the tenant comes from the session
// (TEN-R-01). `npm run lint:dto` fails the build if one ever does.

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class StockInLineDto {
  @IsUUID() productId!: string;
  @IsOptional() @IsString() @MaxLength(60) @Transform(trim) batchNo?: string;
  /** `YYYY-MM-DD`, or `YYYY-MM` for a pack stamped with only a month. */
  @IsOptional() @IsString() @Length(7, 10) @Transform(trim) expiry?: string;
  @IsNumber() @Min(0) @Max(1_000_000) quantity!: number;
  /** Ringgit per dispensing unit, as typed. */
  @IsOptional() @IsNumber() @Min(0) costPrice?: number;
  @IsOptional() @IsNumber() @Min(0) sellingPrice?: number;
  @IsOptional() @IsString() @MaxLength(60) @Transform(trim) barcode?: string;
}

export class StockInDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200)
  @ValidateNested({ each: true }) @Type(() => StockInLineDto)
  lines!: StockInLineDto[];

  @IsOptional() @IsString() @MaxLength(200) @Transform(trim) supplierNote?: string;
  /** An opening balance rather than a delivery. Recorded as such. */
  @IsOptional() @IsBoolean() opening?: boolean;
}

export class AdjustmentDto {
  @IsUUID() batchId!: string;
  @IsEnum(StockMovementType) type!: StockMovementType;
  @IsNumber() @Min(0) @Max(1_000_000) quantity!: number;
  @IsString() @MaxLength(40) @Transform(trim) reasonCode!: string;
  @IsOptional() @IsString() @MaxLength(500) @Transform(trim) reasonText?: string;
}

export class ExpiryWriteOffDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID(undefined, { each: true })
  batchIds!: string[];
  @IsOptional() @IsString() @MaxLength(500) @Transform(trim) note?: string;
}

export class BlockBatchDto {
  @IsString() @Length(10, 500) @Transform(trim) reason!: string;
}

export class MovementQueryDto {
  @IsOptional() @IsUUID() productId?: string;
  @IsOptional() @IsUUID() batchId?: string;
  @IsOptional() @IsEnum(StockMovementType) type?: StockMovementType;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) limit?: number;
}
