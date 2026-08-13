import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * "12 September 2026" — a date someone can act on, not an ISO string (#70).
 *
 * In lib rather than beside either page that shows it: OrderPage renders
 * ProgramPage, so a helper living in one of them would be a circular import.
 */
export function plainDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}
