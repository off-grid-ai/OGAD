// The backup engine is composed once, in the composition root; this module is its public door.
export { createDesktopBackupEngine, type DesktopBackupEngine } from '../composition/backup'
export type { DesktopBackupDelivery } from './sink'
