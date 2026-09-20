import { Transform } from 'class-transformer';
import {
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
} from 'class-validator';
import { ProductType } from '../../../generated/prisma/enums.js';

// No DTO here carries a tenant id: the tenant comes from the session
// (TEN-R-01). `npm run lint:dto` fails the build if one ever does.

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class ProductDto {
  @IsOptional() @IsString() @Length(2, 40) @Transform(trim) sku?: string;
  @IsString() @Length(2, 200) @Transform(trim) name!: string;
  @IsEnum(ProductType) type!: ProductType;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsString() @MaxLength(120) @Transform(trim) brand?: string;
  @IsOptional() @IsString() @MaxLength(200) @Transform(trim) genericName?: string;
  @IsOptional() @IsString() @MaxLength(120) @Transform(trim) drugClass?: string;
  @IsOptional() @IsString() @MaxLength(40) @Transform(trim) form?: string;
  @IsOptional() @IsString() @MaxLength(60) @Transform(trim) strengthText?: string;
  @IsOptional() @IsNumber() @Min(0) strengthValue?: number;
  @IsOptional() @IsString() @MaxLength(20) @Transform(trim) strengthUnit?: string;
  @IsString() @MaxLength(20) @Transform(trim) dispenseUnit!: string;
  @IsOptional() @IsInt() @Min(1) @Max(100_000) packSize?: number;
  @IsOptional() @IsBoolean() isPackDispensed?: boolean;
  @IsOptional() @IsBoolean() isBatched?: boolean;
  @IsOptional() @IsBoolean() isControlled?: boolean;
  @IsOptional() @IsBoolean() isColdChain?: boolean;
  @IsOptional() @IsNumber() @Min(0) maxDailyDose?: number;
  @IsOptional() @IsString() @MaxLength(20) @Transform(trim) maxDailyDoseUnit?: string;
  @IsOptional() @IsNumber() @Min(0) defaultDose?: number;
  @IsOptional() @IsString() @MaxLength(20) @Transform(trim) defaultDoseUnit?: string;
  @IsOptional() @IsString() @MaxLength(20) @Transform(trim) defaultRoute?: string;
  @IsOptional() @IsString() @MaxLength(20) @Transform(trim) defaultFrequency?: string;
  /** In ringgit, as typed. Converted to sen by the service. */
  @IsOptional() @IsNumber() @Min(0) sellingPrice?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) barcodes?: string[];
  @IsOptional() @IsString() @MaxLength(1000) @Transform(trim) notes?: string;
}

export class UpdateProductDto extends ProductDto {
  @IsOptional() @IsString() @Length(2, 200) @Transform(trim) declare name: string;
  @IsOptional() @IsEnum(ProductType) declare type: ProductType;
  @IsOptional() @IsString() @MaxLength(20) @Transform(trim) declare dispenseUnit: string;
  @IsOptional() @IsString() @MaxLength(300) @Transform(trim) priceReason?: string;
}

export class RetireProductDto {
  @IsString() @Length(3, 300) @Transform(trim) reason!: string;
}

export class CategoryDto {
  @IsString() @Length(2, 80) @Transform(trim) name!: string;
  @IsOptional() @IsUUID() parentId?: string;
  @IsOptional() @IsInt() sort?: number;
}

export class BranchStockSettingDto {
  @IsOptional() @IsNumber() @Min(0) minStock?: number;
  @IsOptional() @IsNumber() @Min(0) reorderLevel?: number;
  @IsOptional() @IsNumber() @Min(0) reorderQty?: number;
}
