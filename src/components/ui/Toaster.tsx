import { Toaster as Sonner } from 'sonner';

export { toast } from 'sonner';

/**
 * Short notes from the app ("Saved", "Copied"), in Chapp's look: a white card with the soft shadow, above the bottom
 * bar so Chapp's face stays clear. Mounted once, inside the phone screen (PhoneFrame); call `toast('…')` anywhere.
 */
export function Toaster() {
  return (
    <Sonner
      position="bottom-center"
      offset={{ bottom: 120 }}
      mobileOffset={{ bottom: 120, left: 20, right: 20 }}
      gap={8}
      visibleToasts={2}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'flex w-full items-center gap-3 rounded-inner bg-card px-4 py-3 shadow-[0_0_0_1px_rgba(17,17,19,0.06),0_1px_2px_rgba(17,17,19,0.04),0_6px_22px_rgba(17,17,19,0.07)] font-sans',
          title: 'text-[15px] leading-5 font-semibold text-ink',
          description: 'text-[13px] leading-[18px] font-medium text-text',
          icon: 'text-blue',
          actionButton:
            'ml-auto shrink-0 rounded-full bg-ink px-3 py-1.5 text-[13px] leading-[18px] font-semibold text-white',
          cancelButton: 'shrink-0 rounded-full px-3 py-1.5 text-[13px] leading-[18px] font-semibold text-text',
          error: '[&_[data-icon]]:text-caution',
        },
      }}
    />
  );
}
