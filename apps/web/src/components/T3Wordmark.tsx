import type { SVGProps } from "react";

/** Code-bracket mark for Otter Code's own activity rows. */
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M8.6 5.2 1.8 12l6.8 6.8 2.1-2.1L6 12l4.7-4.7ZM15.4 5.2l6.8 6.8-6.8 6.8-2.1-2.1L18 12l-4.7-4.7Z"
        fill="currentColor"
      />
    </svg>
  );
}
