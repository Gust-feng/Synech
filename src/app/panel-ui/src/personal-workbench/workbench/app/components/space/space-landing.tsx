import spaceKiteScene from '@ui/assets/illustrations/space-kite.svg'
import './space-landing.css'

export function SpaceLanding() {
  return (
    <div className="space-landing" aria-hidden="true">
      <img
        className="space-landing__art"
        src={spaceKiteScene}
        alt=""
        width={640}
        height={430}
        draggable={false}
      />
    </div>
  )
}
