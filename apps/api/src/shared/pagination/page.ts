export type Page<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

export function toPage<T>(items: T[], total: number, page: number, pageSize: number): Page<T> {
  return {
    items,
    total,
    page,
    pageSize,
    pageCount: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
  };
}
