import { Button } from '@offgrid/operator-ui/operator/coss/button'
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle
} from '@offgrid/operator-ui/operator/animate/alert-dialog'
import { settleConfirmDialog, useConfirmDialogState } from '@renderer/lib/confirm-dialog'

/** Renders the confirmDialog / noticeDialog on screen. Mount once per window. */
export function ConfirmDialogHost(): React.JSX.Element {
  const { queue, shown } = useConfirmDialogState()
  const current = queue[0]

  return (
    <AlertDialog
      open={current !== undefined}
      onOpenChange={(open) => {
        if (!open && current) settleConfirmDialog(current, false)
      }}
    >
      <AlertDialogPopup className="sm:max-w-md" aria-label={shown?.title}>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-[17px] font-normal">{shown?.title}</AlertDialogTitle>
          {shown?.description && (
            <AlertDialogDescription className="text-[13px] whitespace-pre-line">
              {shown.description}
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          {shown && shown.cancelLabel !== null && (
            <AlertDialogClose render={<Button size="sm" variant="ghost" />}>
              {shown.cancelLabel}
            </AlertDialogClose>
          )}
          <Button
            size="sm"
            variant={shown?.destructive ? 'destructive' : 'default'}
            onClick={() => current && settleConfirmDialog(current, true)}
          >
            {shown?.confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  )
}
