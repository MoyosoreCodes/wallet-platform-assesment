import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Request } from 'express';

export class PaginationDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;
}

export interface PaginatedResult<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    links: { self: string; next?: string; prev?: string };
  };
}

export function buildPagination<T>(
  data: T[],
  total: number,
  params: PaginationDto,
  req: Request,
): PaginatedResult<T> {
  const page = Number(params.page ?? 1);
  const limit = Number(params.limit ?? 10);
  const totalPages = Math.ceil(total / limit);
  const hasNextPage = page < totalPages;
  const hasPreviousPage = page > 1;

  const query = new URLSearchParams();
  Object.entries(req.query).forEach(([key, value]) => {
    if (typeof value === 'string') query.set(key, value);
  });
  query.set('limit', String(limit));

  const linkFor = (targetPage: number) => {
    query.set('page', String(targetPage));
    return `${req.path}?${query.toString()}`;
  };

  return {
    data,
    meta: {
      page,
      limit,
      total,
      totalPages,
      hasNextPage,
      hasPreviousPage,
      links: {
        self: linkFor(page),
        ...(hasNextPage && { next: linkFor(page + 1) }),
        ...(hasPreviousPage && { prev: linkFor(page - 1) }),
      },
    },
  };
}
