import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  // Validate input type if provided as a string
  if (typeof type === 'string' && !["text", "email", "password", "number", "search", "tel", "url", "date", "time", "month", "week", "checkbox", "radio", "file"].includes(type)) {
    console.error(`Invalid input type "${type}" provided. Valid types are: text, email, password, number, search, tel, url, date, time, month, week, checkbox, radio, file. Using default behavior.`)
    // Let React handle the invalid type - it will default to 'text' in the DOM
    // We don't override type here to preserve the original prop value for debugging
  }

  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Input }