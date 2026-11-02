"use client";

import { Button } from "@/components/ui";

/** The browser's print dialog, where "Save as PDF" lives. */
export function PrintButton() {
  return <Button type="button" size="sm" variant="outline" onClick={() => window.print()}>Print / PDF</Button>;
}
