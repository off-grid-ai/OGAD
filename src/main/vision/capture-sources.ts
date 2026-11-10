// The one way main-process code lists capture sources. Chromium captures the screen in this
// process, so a driver fault here ends the app; the guard keeps that from repeating each launch.
import { desktopCapturer, type DesktopCapturerSource, type SourcesOptions } from 'electron'
import { nativeSteps } from '../native-step-guard'

/** No sources at all when screen capture crashed the app on this machine before. */
export async function getCaptureSources(options: SourcesOptions): Promise<DesktopCapturerSource[]> {
  return nativeSteps().run(
    'screen-capture',
    () => desktopCapturer.getSources(options),
    () => []
  )
}
