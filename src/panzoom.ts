/**
 * Panzoom for panning and zooming elements using CSS transforms
 * https://github.com/timmywil/panzoom
 *
 * Copyright Timmy Willison and other contributors
 * Released under the MIT license
 * https://github.com/timmywil/panzoom/blob/main/MIT-License.txt
 *
 */
import './polyfills'

import type {
  PanOptions,
  PanzoomEvent,
  PanzoomEventDetail,
  PanzoomObject,
  PanzoomOptions,
  ZoomOptions
} from './types'
import { addPointer, getDistance, getMiddle, removePointer } from './pointers'
import { destroyPointer, eventNames, onPointer } from './events'
import { getDimensions, setStyle, setTransform, setTransition } from './css'

import isAttached from './isAttached'
import isExcluded from './isExcluded'
import isSVGElement from './isSVGElement'
import shallowClone from './shallowClone'

const defaultOptions: PanzoomOptions = {
  animate: false,
  canvas: false,
  cursor: 'move',
  disablePan: false,
  disableZoom: false,
  disableXAxis: false,
  disableYAxis: false,
  duration: 200,
  easing: 'ease-in-out',
  exclude: [],
  excludeClass: 'panzoom-exclude',
  handleStartEvent: (e: Event) => {
    e.preventDefault()
    e.stopPropagation()
  },
  maxScale: 4,
  minScale: 0.125,
  overflow: 'hidden',
  panOnlyWhenZoomed: false,
  relative: false,
  setTransform,
  startX: 0,
  startY: 0,
  startScale: 1,
  step: 0.3,
  touchAction: 'none'
}

function Panzoom(
  elem: HTMLElement | SVGElement,
  options?: Omit<PanzoomOptions, 'force'>
): PanzoomObject {
  if (!elem) {
    throw new Error('Panzoom requires an element as an argument')
  }
  if (elem.nodeType !== 1) {
    throw new Error('Panzoom requires an element with a nodeType of 1')
  }
  if (!isAttached(elem)) {
    throw new Error('Panzoom should be called on elements that have been attached to the DOM')
  }

  options = {
    ...defaultOptions,
    ...options
  }

  const isSVG = isSVGElement(elem)

  const parent = elem.parentNode as HTMLElement | SVGElement

  // Set parent styles
  parent.style.overflow = options.overflow
  parent.style.userSelect = 'none'
  // This is important for mobile to
  // prevent scrolling while panning
  parent.style.touchAction = options.touchAction
  // Set the cursor style on the parent if we're in canvas mode
  ;(options.canvas ? parent : elem).style.cursor = options.cursor

  // Set element styles
  elem.style.userSelect = 'none'
  elem.style.touchAction = options.touchAction
  // The default for HTML is '50% 50%'
  // The default for SVG is '0 0'
  // SVG can't be changed in IE
  setStyle(
    elem,
    'transformOrigin',
    typeof options.origin === 'string' ? options.origin : isSVG ? '0 0' : '50% 50%'
  )

  function resetStyle() {
    parent.style.overflow = ''
    parent.style.userSelect = ''
    parent.style.touchAction = ''
    parent.style.cursor = ''
    elem.style.cursor = ''
    elem.style.userSelect = ''
    elem.style.touchAction = ''
    setStyle(elem, 'transformOrigin', '')
  }

  function setOptions(opts: Omit<PanzoomOptions, 'force'> = {}) {
    for (const key in opts) {
      if (opts.hasOwnProperty(key)) {
        options[key] = opts[key]
      }
    }
    // Handle option side-effects
    if (opts.hasOwnProperty('cursor') || opts.hasOwnProperty('canvas')) {
      parent.style.cursor = elem.style.cursor = ''
      ;(options.canvas ? parent : elem).style.cursor = options.cursor
    }
    if (opts.hasOwnProperty('overflow')) {
      parent.style.overflow = opts.overflow
    }
    if (opts.hasOwnProperty('touchAction')) {
      parent.style.touchAction = opts.touchAction
      elem.style.touchAction = opts.touchAction
    }
  }

  let x = 0
  let y = 0
  let scale = 1
  let isPanning = false
  zoom(options.startScale, { animate: false, force: true })
  // Wait for scale to update
  // for accurate dimensions
  // to constrain initial values
  setTimeout(() => {
    pan(options.startX, options.startY, { animate: false, force: true })
  })

  function trigger(eventName: PanzoomEvent, detail: PanzoomEventDetail, opts: PanzoomOptions) {
    if (opts.silent) {
      return
    }
    const event = new CustomEvent(eventName, { detail })
    elem.dispatchEvent(event)
  }

  function setTransformWithEvent(
    eventName: PanzoomEvent,
    opts: PanzoomOptions,
    originalEvent?: PanzoomEventDetail['originalEvent']
  ) {
    const value = { x, y, scale, isSVG, originalEvent }
    requestAnimationFrame(() => {
      if (typeof opts.animate === 'boolean') {
        if (opts.animate) {
          setTransition(elem, opts)
        } else {
          setStyle(elem, 'transition', 'none')
        }
      }
      opts.setTransform(elem, value, opts)
      trigger(eventName, value, opts)
      trigger('panzoomchange', value, opts)
    })
    return value
  }

  function getTransformOriginOffsets(size: number, originTransform: string): {min: number, max: number} {
    let min = 0;
    let max = 0;

    if(originTransform.indexOf("%") !== -1) {
      max = (size * parseFloat(originTransform)) / 100;
      min = max - size;
    }

    if(originTransform.indexOf("px") !== -1) {
        max = parseFloat(originTransform);
        min = -(size + originTransform);
    }

    if(originTransform === "0") {
        min = -size;
    }

    return {
        min: min,
        max: max
    }
  }

  function constrainXY(
    toX: number | string,
    toY: number | string,
    toScale: number,
    panOptions?: PanOptions
  ) {
    const opts = { ...options, ...panOptions }
    const result = { x, y, opts }
    if (!opts.force && (opts.disablePan || (opts.panOnlyWhenZoomed && scale === opts.startScale))) {
      return result
    }
    toX = parseFloat(toX as string)
    toY = parseFloat(toY as string)

    if (!opts.disableXAxis) {
      result.x = (opts.relative ? x : 0) + toX
    }

    if (!opts.disableYAxis) {
      result.y = (opts.relative ? y : 0) + toY
    }

    const dims = getDimensions(elem)
    const realWidth = dims.elem.width / scale
    const realHeight = dims.elem.height / scale
    const scaledWidth = realWidth * toScale
    const scaledHeight = realHeight * toScale
      
    const originTransforms = opts.origin.split(" ");

    if(scaledWidth <= dims.parent.width) {
      result.x = 0;
    } else {
      const widthDiff = scaledWidth - dims.parent.width;
      const transformOriginX = originTransforms[0];

      const offsetsX = getTransformOriginOffsets(widthDiff, transformOriginX);

      result.x = Math.max(Math.min(result.x, offsetsX.max / toScale), offsetsX.min / toScale);
    }

    if(scaledHeight <= dims.parent.height) {
      result.y = 0;
    } else {
        const heightDiff = scaledHeight - dims.parent.height + dims.parent.padding.top;
        const transformOriginY = originTransforms[1];

        const offsetsY = getTransformOriginOffsets(heightDiff, transformOriginY);
        result.y = Math.max(Math.min(result.y, offsetsY.max / toScale), offsetsY.min / toScale);
    }

    if (opts.roundPixels) {
      result.x = Math.round(result.x)
      result.y = Math.round(result.y)
    }

    return result
  }

  function constrainScale(toScale: number, zoomOptions?: ZoomOptions) {
    const opts = { ...options, ...zoomOptions }
    const result = { scale, opts }
    if (!opts.force && opts.disableZoom) {
      return result
    }

    let minScale = options.minScale
    let maxScale = options.maxScale

    result.scale = Math.min(Math.max(toScale, minScale), maxScale)
    return result
  }

  function pan(
    toX: number | string,
    toY: number | string,
    panOptions?: PanOptions,
    originalEvent?: PanzoomEventDetail['originalEvent']
  ) {
    const result = constrainXY(toX, toY, scale, panOptions)

    // Only try to set if the result is somehow different
    if (x !== result.x || y !== result.y) {
      x = result.x
      y = result.y
      return setTransformWithEvent('panzoompan', result.opts, originalEvent)
    }
    return { x, y, scale, isSVG, originalEvent }
  }

  function zoom(
    toScale: number,
    zoomOptions?: ZoomOptions,
    originalEvent?: PanzoomEventDetail['originalEvent']
  ) {
    const result = constrainScale(toScale, zoomOptions)
    const opts = result.opts
    if (!opts.force && opts.disableZoom) {
      return
    }
    toScale = result.scale
    let toX = x
    let toY = y

    if (opts.focal) {
      // The difference between the point after the scale and the point before the scale
      // plus the current translation after the scale
      // neutralized to no scale (as the transform scale will apply to the translation)
      const focal = opts.focal
      toX = (focal.x / toScale - focal.x / scale + x * toScale) / toScale
      toY = (focal.y / toScale - focal.y / scale + y * toScale) / toScale
    }
    const panResult = constrainXY(toX, toY, toScale, { relative: false, force: true })
    x = panResult.x
    y = panResult.y
    scale = toScale
    return setTransformWithEvent('panzoomzoom', opts, originalEvent)
  }

  function zoomInOut(isIn: boolean, zoomOptions?: ZoomOptions) {
    const opts = { ...options, animate: true, ...zoomOptions }
    return zoom((scale * 1000 + (isIn ? 1 : -1) * opts.step * 1000) / 1000, opts)
  }

  function zoomIn(zoomOptions?: ZoomOptions) {
    return zoomInOut(true, zoomOptions)
  }

  function zoomOut(zoomOptions?: ZoomOptions) {
    return zoomInOut(false, zoomOptions)
  }

  function zoomToPoint(
    toScale: number,
    point: { clientX: number; clientY: number },
    zoomOptions?: ZoomOptions,
    originalEvent?: PanzoomEventDetail['originalEvent']
  ) {
    const dims = getDimensions(elem)
    
    const currentCenterX = dims.parent.left + dims.parent.width / 2;
    const currentCenterY = dims.parent.top + dims.parent.height / 2;

    const mousePosToCurrentCenterDistanceX = point.clientX - currentCenterX;
    const mousePosToCurrentCenterDistanceY = point.clientY - currentCenterY;

    const newCenterX = currentCenterX + mousePosToCurrentCenterDistanceX * toScale;
    const newCenterY = currentCenterY + mousePosToCurrentCenterDistanceY * toScale;

    const offsetX = newCenterX - currentCenterX;
    const offsetY = newCenterY - currentCenterY;

    const focal = {
      x: offsetX,
      y: offsetY
    };

    return zoom(toScale, { ...zoomOptions, animate: false, focal }, originalEvent)
  }

  function zoomWithWheel(event: WheelEvent, zoomOptions?: ZoomOptions) {
    // Need to prevent the default here
    // or it conflicts with regular page scroll
    event.preventDefault()

    const opts = { ...options, ...zoomOptions, animate: false }

    // Normalize to deltaX in case shift modifier is used on Mac
    const delta = event.deltaY === 0 && event.deltaX ? event.deltaX : event.deltaY
    const wheel = delta < 0 ? 1 : -1
    const toScale = constrainScale((scale * 1000 + (wheel * opts.step) * 1000) / 1000, opts).scale

    return zoomToPoint(toScale, event, opts, event)
  }

  function reset(resetOptions?: PanzoomOptions) {
    const opts = { ...options, animate: true, force: true, ...resetOptions }
    scale = constrainScale(opts.startScale, opts).scale
    const panResult = constrainXY(opts.startX, opts.startY, scale, opts)
    x = panResult.x
    y = panResult.y
    return setTransformWithEvent('panzoomreset', opts)
  }

  let origX: number
  let origY: number
  let startClientX: number
  let startClientY: number
  let startScale: number
  let startDistance: number
  const pointers: PointerEvent[] = []

  function handleDown(event: PointerEvent) {
    // Don't handle this event if the target is excluded
    if (isExcluded(event.target as Element, options)) {
      return
    }
    addPointer(pointers, event)
    isPanning = true
    options.handleStartEvent(event)
    origX = x
    origY = y

    trigger('panzoomstart', { x, y, scale, isSVG, originalEvent: event }, options)

    // This works whether there are multiple
    // pointers or not
    const point = getMiddle(pointers)
    startClientX = point.clientX
    startClientY = point.clientY
    startScale = scale
    startDistance = getDistance(pointers)
  }

  function move(event: PointerEvent) {
    if (
      !isPanning ||
      origX === undefined ||
      origY === undefined ||
      startClientX === undefined ||
      startClientY === undefined
    ) {
      return
    }
    addPointer(pointers, event)
    const current = getMiddle(pointers)
    if (pointers.length > 1) {
      // A startDistance of 0 means
      // that there weren't 2 pointers
      // handled on start
      if (startDistance === 0) {
        startDistance = getDistance(pointers)
      }
      // Use the distance between the first 2 pointers
      // to determine the current scale
      const diff = getDistance(pointers) - startDistance
      const toScale = constrainScale((diff * options.step) / 80 + startScale).scale
      zoomToPoint(toScale, current, { animate: false }, event)
    } else {
      // Panning during pinch zoom can cause issues
      // because the zoom has not always rendered in time
      // for accurate calculations
      // See https://github.com/timmywil/panzoom/issues/512
      pan(
        origX + (current.clientX - startClientX) / scale,
        origY + (current.clientY - startClientY) / scale,
        {
          animate: false
        },
        event
      )
    }
  }

  function handleUp(event: PointerEvent) {
    // Don't call panzoomend when panning with 2 touches
    // until both touches end
    if (pointers.length === 1) {
      trigger('panzoomend', { x, y, scale, isSVG, originalEvent: event }, options)
    }
    // Note: don't remove all pointers
    // Can restart without having to reinitiate all of them
    // Remove the pointer regardless of the isPanning state
    removePointer(pointers, event)
    if (!isPanning) {
      return
    }
    isPanning = false
    origX = origY = startClientX = startClientY = undefined
  }

  let bound = false
  function bind() {
    if (bound) {
      return
    }
    bound = true
    onPointer('down', options.canvas ? parent : elem, handleDown)
    onPointer('move', document, move, { passive: true })
    onPointer('up', document, handleUp, { passive: true })
  }

  function destroy() {
    bound = false
    destroyPointer('down', options.canvas ? parent : elem, handleDown)
    destroyPointer('move', document, move)
    destroyPointer('up', document, handleUp)
  }

  if (!options.noBind) {
    bind()
  }

  return {
    bind,
    destroy,
    eventNames,
    getPan: () => ({ x, y }),
    getScale: () => scale,
    getOptions: () => shallowClone(options),
    pan,
    reset,
    resetStyle,
    setOptions,
    setStyle: (name: string, value: string) => setStyle(elem, name, value),
    zoom,
    zoomIn,
    zoomOut,
    zoomToPoint,
    zoomWithWheel
  }
}

Panzoom.defaultOptions = defaultOptions

export { PanzoomObject, PanzoomOptions }
export default Panzoom
