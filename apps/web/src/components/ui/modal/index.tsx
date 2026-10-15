import { useEffect, useId, useRef, type ReactNode } from "react";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Width and padding of the dialog body, e.g. "max-w-150 p-6 lg:p-8". */
  className?: string;
  children: ReactNode;
  /** Header: the title (and an optional line under it) sit left, the close button right — in the normal flow, so the
   *  button can never overlap the title or the first field at any width. Every dialog should pass a title. */
  title?: ReactNode;
  description?: ReactNode;
  /** Extra header content right of the title, before the close button (badges, a status). */
  headerExtra?: ReactNode;
  showCloseButton?: boolean;
  isFullscreen?: boolean;
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close"
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-500 transition-colors hover:bg-gray-200 hover:text-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M6.04289 16.5413C5.65237 16.9318 5.65237 17.565 6.04289 17.9555C6.43342 18.346 7.06658 18.346 7.45711 17.9555L11.9987 13.4139L16.5408 17.956C16.9313 18.3466 17.5645 18.3466 17.955 17.956C18.3455 17.5655 18.3455 16.9323 17.955 16.5418L13.4129 11.9997L17.955 7.4576C18.3455 7.06707 18.3455 6.43391 17.955 6.04338C17.5645 5.65286 16.9313 5.65286 16.5408 6.04338L11.9987 10.5855L7.45711 6.0439C7.06658 5.65338 6.43342 5.65338 6.04289 6.0439C5.65237 6.43442 5.65237 7.06759 6.04289 7.45811L10.5845 11.9997L6.04289 16.5413Z"
          fill="currentColor"
        />
      </svg>
    </button>
  );
}

export const Modal: React.FC<ModalProps> = ({ isOpen, onClose, children, className, title, description, headerExtra, showCloseButton = true, isFullscreen = false }) => {
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    if (isOpen) document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  useEffect(() => {
    document.body.style.overflow = isOpen ? "hidden" : "unset";
    return () => {
      document.body.style.overflow = "unset";
    };
  }, [isOpen]);

  if (!isOpen) return null;
  if (isFullscreen) {
    return (
      <div className="modal fixed inset-0 z-99999 flex items-center justify-center">
        <div ref={modalRef} className={`h-full w-full ${className ?? ""}`}>{children}</div>
      </div>
    );
  }

  const hasHeader = title !== undefined || description !== undefined || headerExtra !== undefined || showCloseButton;
  return (
    <div className="modal fixed inset-0 z-99999 flex items-center justify-center p-3 sm:p-6">
      <div className="fixed inset-0 h-full w-full bg-gray-400/50 backdrop-blur-[32px]" onClick={onClose}></div>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title !== undefined ? titleId : undefined}
        className={`relative flex max-h-[calc(100dvh-1.5rem)] w-full flex-col overflow-hidden rounded-3xl bg-white sm:max-h-[calc(100dvh-3rem)] dark:bg-gray-900 ${split(className).frame}`}
        onClick={(e) => e.stopPropagation()}
      >
          {hasHeader && (
            <div className="flex shrink-0 items-start gap-4 border-b border-gray-100 px-5 py-4 sm:px-6 dark:border-gray-800">
              <div className="min-w-0 flex-1">
                {title !== undefined && (
                  <h4 id={titleId} className="text-lg font-semibold break-words text-gray-800 dark:text-white/90">
                    {title}
                  </h4>
                )}
                {description !== undefined && <div className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{description}</div>}
              </div>
              {headerExtra}
              {showCloseButton && <CloseButton onClose={onClose} />}
            </div>
          )}
          <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${split(className).body}`}>{children}</div>
      </div>
    </div>
  );
};

/** className: padding classes go to the body below the header, everything else (width…) to the dialog frame. The old
 *  `pe-20` / `pe-24` that kept text clear of a floating close button are dropped: the button is in the header now. */
function split(className?: string): { frame: string; body: string } {
  const all = (className ?? "").split(/\s+/).filter(Boolean);
  const isPadding = (c: string) => /^(?:[a-z0-9]+:)*p[sexytblr]?-/.test(c);
  const legacyEnd = (c: string) => /^(?:[a-z0-9]+:)*pe-(?:20|24)$/.test(c);
  return { frame: all.filter((c) => !isPadding(c)).join(" "), body: all.filter((c) => isPadding(c) && !legacyEnd(c)).join(" ") };
}
