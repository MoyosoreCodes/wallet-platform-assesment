import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class DepositDto {
  @ApiProperty({ example: 100 })
  @IsNumber()
  @IsPositive()
  amount: number;

  @ApiProperty()
  @IsString()
  currency: string;

  @ApiPropertyOptional({ description: 'Client supplied idempotency key' })
  @IsOptional()
  @IsString()
  reference?: string;

}
