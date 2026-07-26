import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { PaginationDto, buildPagination } from '../common/dto/pagination.dto';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { DepositDto } from './dto/deposit.dto';
import { TransferDto } from './dto/transfer.dto';
import { WithdrawDto } from './dto/withdraw.dto';
import { WalletsService } from './wallets.service';

@ApiTags('wallets')
@Controller('wallets')
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Post()
  create(@Body() dto: CreateWalletDto) {
    return this.walletsService.createWallet(dto);
  }

  @Post('transfer')
  transfer(@Body() dto: TransferDto) {
    return this.walletsService.transfer(dto);
  }

  @Get(':id')
  findOne(@Param('id', ParseObjectIdPipe) id: string) {
    return this.walletsService.getWallet(id);
  }

  @Get(':id/summary')
  summary(@Param('id', ParseObjectIdPipe) id: string) {
    return this.walletsService.getWalletSummary(id);
  }

  @Get(':id/transactions')
  async transactions(
    @Param('id', ParseObjectIdPipe) id: string,
    @Query() query: PaginationDto,
    @Req() req: Request,
  ) {
    const { data, count } = await this.walletsService.getWalletTransactions(id, query);
    return buildPagination(data, count, query, req);
  }

  @Get(':id/ledger-entries')
  async ledgerEntries(
    @Param('id', ParseObjectIdPipe) id: string,
    @Query() query: PaginationDto,
    @Req() req: Request,
  ) {
    const { data, count } = await this.walletsService.getWalletLedgerEntries(id, query);
    return buildPagination(data, count, query, req);
  }

  @Post(':id/deposit')
  deposit(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: DepositDto) {
    return this.walletsService.deposit(id, dto);
  }

  @Post(':id/withdraw')
  withdraw(@Param('id', ParseObjectIdPipe) id: string, @Body() dto: WithdrawDto) {
    return this.walletsService.withdraw(id, dto);
  }
}
