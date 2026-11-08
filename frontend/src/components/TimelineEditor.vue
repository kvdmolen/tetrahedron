<template>
    <div class="tl" ref="root" tabindex="0" :style="sizes" @keydown="onKey">
        <div class="tl-controls">
            <button class="tl-icon-button" :title="playing ? 'Pause' : 'Play'" :aria-label="playing ? 'Pause' : 'Play'" @click="togglePlay">
                <AppIcon :name="playing ? 'pause' : 'play'" />
            </button>
            <button class="tl-icon-button" title="Back to the start" aria-label="Back to the start" @click="reset"><AppIcon name="reset" /></button>
            <label class="tl-check tl-speed" title="Playback speed, 0.1× to 10×. Double-click: back to 1×">Speed
                <span class="tl-slider tl-slider-centered"><input type="range" min="-1" max="1" step="0.01" v-model.number="speedExponent" @dblclick="speedExponent = 0"></span>
                <span class="tl-speed-value">{{ speedLabel }}</span>
            </label>
            <label class="tl-check"><input type="checkbox" v-model="looping"> Loop</label>
            <label class="tl-check" title="Time of the last keyframe">Total
                <input class="tl-time" type="number" min="0.1" step="0.1" :value="end" @keydown.enter="$event.target.blur()" @change="totalChange"> s</label>
            <label class="tl-check" title="When looping, jump back to this time (empty: the start)">Loop start
                <input class="tl-time" type="number" min="0" step="0.1" placeholder="–" :value="loopStart ?? ''" @keydown.enter="$event.target.blur()" @change="loopPointChange($event, 'loopStart')"> s</label>
            <label class="tl-check" title="When looping, jump back at this time (empty: the end)">Loop end
                <input class="tl-time" type="number" min="0" step="0.1" placeholder="–" :value="loopEnd ?? ''" @keydown.enter="$event.target.blur()" @change="loopPointChange($event, 'loopEnd')"> s</label>
            <span class="tl-gap"></span>
            <button class="tl-icon-button" title="Zoom in" aria-label="Zoom in" @click="zoomBy(1.2)"><AppIcon name="zoomIn" /></button>
            <button class="tl-icon-button" title="Zoom out" aria-label="Zoom out" @click="zoomBy(1 / 1.2)"><AppIcon name="zoomOut" /></button>
            <button class="tl-icon-button" title="Fit the whole timeline" aria-label="Fit the whole timeline" @click="fit"><AppIcon name="fit" /></button>
            <span class="tl-gap"></span>
            <button @click="addKeyframeFromSliders" title="Add a keyframe at the playhead with the sliders you moved (on a keyframe: update it)">Add keyframe</button>
            <button @click="removeKeyframe(selIdx)" :disabled="selIdx < 0 || isEdge(selIdx)" title="Delete the selected keyframe (Delete key)">Remove keyframe</button>
            <div class="tl-controls-end"><slot name="controls"></slot></div>
        </div>

        <div class="tl-body" ref="body">
            <div class="tl-labels">
                <div class="tl-label tl-label-ruler">{{ t.toFixed(2) }} s</div>
                <div class="tl-label tl-label-main">{{ selIdx >= 0 ? 'Keyframe ' + (selIdx + 1) : 'Keyframes' }}</div>
                <div class="tl-label tl-label-lane" v-for="p in params" :key="p.id">
                    <input type="checkbox" :class="{ hidden: selIdx < 0 }" :checked="selIdx >= 0 && has(kfs[selIdx], p.id)"
                           :disabled="selIdx < 0 || isEdge(selIdx)" @change="toggleParam(selIdx, p)"
                           :title="isEdge(selIdx) ? 'First and last keyframe control every parameter' : 'Controlled in this keyframe'">
                    <span class="tl-name">{{ p.name }}</span>
                    <span class="tl-slider" :class="{ 'tl-slider-centered': p.range[0] === -p.range[1], 'tl-slider-moved': p.id in manualValues, 'tl-slider-keyframe': selIdx >= 0 }">
                        <input type="range" :min="p.range[0]" :max="p.range[1]" step="0.01" :value="output[p.id]" :disabled="playing"
                               :title="selIdx >= 0 ? `${fmt(output[p.id])}, in the selected keyframe` : `${fmt(output[p.id])}. Double-click: back to the timeline`" :aria-label="p.name"
                               @input="sliderInput(p, $event)" @dblclick="sliderReset(p)">
                    </span>
                </div>
            </div>

            <div class="tl-scroll" ref="scroll">
                <div class="tl-track" ref="track" :style="{ width: trackWidth + 'px' }">
                    <div class="tl-ruler" @pointerdown="scrubStart">
                        <div class="tl-tick" v-for="tick in ticks" :key="tick.t" :style="{ left: tick.x + 'px' }"><span>{{ tick.label }}</span></div>
                        <div class="tl-playhead-handle" :style="{ left: x(t) + 'px' }" @pointerdown.stop="playheadDragStart"></div>
                    </div>

                    <div class="tl-main" @pointerdown.self="selectedId = null" @dblclick.self="addKeyframe(timeAt($event))">
                        <div class="tl-frame" v-for="(kf, i) in kfs" :key="kf.id" :style="{ left: x(kf.time) + 'px' }"
                             :class="{ selected: kf.id === selectedId, fixed: isEdge(i) }">
                            <div class="tl-frame-handle" @pointerdown="frameDragStart($event, i)" @dblclick="editTime(i)"
                                 :title="i === 0 ? '' : 'Drag to move, double-click to type the time'"></div>
                            <div class="tl-edit" v-if="isEditing('time', kf)">
                                <input type="text" inputmode="decimal" v-model="editing.text" @keydown.stop="editKey" @blur="commitEdit"> s
                            </div>
                        </div>
                    </div>

                    <div class="tl-lane" v-for="p in params" :key="p.id" @dblclick="laneDblClick($event, p)">
                        <div class="tl-zero" v-if="p.range[0] < 0 && p.range[1] > 0" :style="{ top: y(p, 0) + 'px' }"></div>
                        <svg class="tl-curves" :width="trackWidth" :height="laneHeightPx">
                            <path v-for="segment in curves(p)" :key="segment.key" :d="segment.d" />
                        </svg>
                        <template v-for="(kf, i) in kfs" :key="kf.id">
                            <div class="tl-frame" v-if="has(kf, p.id)" :style="{ left: x(kf.time) + 'px' }">
                                <div :class="['tl-point', { active: isDragging(kf, p) }]" :style="{ top: y(p, kf.values[p.id]) + 'px' }"
                                     @pointerdown="pointDragStart($event, i, p)" @dblclick.stop="editValue(kf, p)"
                                     title="Drag to change, double-click to type the value"></div>
                                <div class="tl-drag-value" v-if="isDragging(kf, p)" :style="{ top: y(p, kf.values[p.id]) + 'px' }">{{ fmt(kf.values[p.id]) }}</div>
                                <div class="tl-edit" v-if="isEditing('value', kf, p)" :style="{ top: y(p, kf.values[p.id]) + 'px' }">
                                    <input type="text" inputmode="decimal" v-model="editing.text" @keydown.stop="editKey" @blur="commitEdit">
                                    <button v-if="!isEdge(i)" @pointerdown.prevent.stop="removePoint(i, p)" title="Remove this point">&times;</button>
                                </div>
                            </div>
                            <div class="tl-frame ghost" v-else-if="kf.id === selectedId" :style="{ left: x(kf.time) + 'px' }">
                                <div class="tl-point" :style="{ top: y(p, valueAt(p, kf.time)) + 'px' }"
                                     @click="toggleParam(i, p)" @dblclick.stop title="Click to control this parameter in this keyframe"></div>
                            </div>
                        </template>
                    </div>

                    <div class="tl-loop-line" v-if="showLoopLine(loopStart)" :style="{ left: x(loopStart) + 'px' }"></div>
                    <div class="tl-loop-line" v-if="showLoopLine(loopEnd)" :style="{ left: x(loopEnd) + 'px' }"></div>
                    <div class="tl-playhead" :style="{ left: x(t) + 'px' }"></div>
                </div>
            </div>
        </div>

    </div>
</template>

<script setup>
// Keyframe timeline for a set of parameters, each ranging 0..1 or -1..1.
//
//   <timeline-editor :parameters="parameters" v-model:keyframes="keyframes" v-model:duration="duration"
//                    v-model:time="time" @output="values => ..." />
//
// parameters  [{ "id": "x", "name": "Position X", "range": [-1, 1], "default": 0 }, ...]
//             range defaults to [0, 1]; default defaults to 0 (or the range minimum).
// keyframes   [{ "time": 0, "values": { "x": 0, ... } }, ..., { "time": 10, "values": { ... } }]
//             The first keyframe (always at t = 0) and the last one (always at the total time) hold
//             every parameter; the ones in between only the parameters they control.
// duration    total time in seconds = the time of the last keyframe, which cannot be dragged. Loaded
//             keyframes bring their own total time; this sets it for an empty timeline, or changes it.
//             It never goes below the last keyframe in between.
// time        playhead position in seconds.
// loopStart, loopEnd  optional loop points in seconds, null = none (shown as thin lines). When looping,
//             playback jumps from loopEnd (or the end) to loopStart (or 0); the first pass starts wherever
//             the playhead is. Keep the values at both points equal for a smooth loop.
// loop        repeat when playing (v-model:loop, the Loop checkbox).
// speed       playback speed, 0.1 to 10, 1 = real time (v-model:speed, the speed slider).
// laneHeight  px per parameter lane (= its full value range); laneGap: px between lanes.
// fillHeight  lanes share the editor's height (give the editor a height), never below minLaneHeight;
//             the controls stay on top and the lanes scroll when they don't fit.
// output      event with { id: value } for every parameter at the playhead, on every change, with the sliders
//             moved by hand taking the place of the timeline's value.
// #controls   slot at the end of the controls row (for example save and open buttons).
//
// The red line is the playhead; it's moved by clicking the time ruler or dragging its handle there.
// Dragging a keyframe moves it in steps of KEYFRAME_DRAG_STEP seconds, whatever the zoom. It can pass other
// keyframes, but never lands on one: it jumps over to the next free step in the direction of the drag.
//
// The slider in front of each lane follows the value at the playhead. While paused it can be moved by hand.
// With a keyframe selected it edits that keyframe: selecting one puts the playhead on it, and moving the
// playhead away (or playing) deselects it. Without one, the output follows the slider and the timeline stays as
// it is, until the playhead moves or Add keyframe puts the moved sliders, and only those, in a keyframe there.
//
// The values between keyframes come from shared/timeline.js, so the server can play timelines identically.
//
// Exposed: play(), pause(), seek(time), addKeyframe(time), addKeyframeFromSliders(), removeKeyframe(index).

import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { EASE, valueAt as timelineValueAt } from '@shared/timeline.js'
import AppIcon from './AppIcon.vue'

const PAD = 12           // px left of t = 0, so the first keyframe handle stays visible
const RULER_H = 32       // px, time ruler
const MAIN_H = 24        // px, keyframe bar
const TRACK_BOTTOM = 10  // px, padding under the last lane (keep in sync with .tl-track)
const TRACK_END_PX = 60  // px of track after the last keyframe
const MIN_GAP = 0.05     // s, minimum distance between keyframes
const KEYFRAME_DRAG_STEP = 0.1 // s
const SNAP_PX = 6        // px, a double-click this close to a keyframe adds to that keyframe
const ZOOM_RANGE = [5, 2000] // px per second
const TICK_STEPS = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]

const clamp = (v, min, max) => Math.min(Math.max(v, min), max)
const round = (v, decimals) => Math.round(v * 10 ** decimals) / 10 ** decimals
const has = (kf, id) => kf.values[id] !== undefined // a plain read, which Vue tracks (Object.hasOwn isn't)
const speedToExponent = (value) => clamp(Math.log10(value), -1, 1)

const props = defineProps({
    parameters: { type: Array, required: true },
    keyframes: { type: Array, default: null },
    time: { type: Number, default: 0 },
    duration: { type: Number, default: null }, // total time; from the keyframes (or 10 s) when not given
    zoom: { type: Number, default: null },     // px per second; fits the width when not given
    loop: { type: Boolean, default: false },
    speed: { type: Number, default: 1 },
    loopStart: { type: Number, default: null },
    loopEnd: { type: Number, default: null },
    laneHeight: { type: Number, default: 50 },
    laneGap: { type: Number, default: 18 },
    fillHeight: { type: Boolean, default: false },
    minLaneHeight: { type: Number, default: 18 },
})
const emit = defineEmits(['update:keyframes', 'update:duration', 'update:time', 'update:loop', 'update:speed', 'update:loopStart', 'update:loopEnd', 'output'])

const root = ref(null)
const body = ref(null)
const scroll = ref(null)
const track = ref(null)
const bodyHeight = ref(0)            // px available for ruler, keyframe bar and lanes (fillHeight mode)

const kfs = ref([])                  // [{ id, time, values }], sorted by time
const t = ref(0)                     // playhead
const pxPerSecond = ref(props.zoom || 100)
const viewWidth = ref(0)
const selectedId = ref(null)
const drag = ref(null)               // { kfId, paramId } while dragging a point
const editing = ref(null)            // { kind: 'time' | 'value', kfId, paramId, text } while typing a value
const playing = ref(false)
const looping = ref(props.loop)
const speedExponent = ref(speedToExponent(props.speed)) // the speed slider: logarithmic, -1 = 0.1×, 0 = 1×, 1 = 10×
const manualValues = ref({})         // { id: value } of the sliders moved by hand, not part of the timeline

let nextKeyframeId = 1
let lastEmitted = null               // JSON of the keyframes last sent to the parent
let stopDrag = null
let raf = 0
let resizeObserver = null

const params = computed(() => props.parameters.map((p) => {
    const id = String(p.id ?? p.name)
    const range = Array.isArray(p.range) ? [Number(p.range[0]), Number(p.range[1])] : [0, 1]
    const fallback = range[0] <= 0 && range[1] >= 0 ? 0 : range[0]
    return { id, name: p.name ?? id, range, default: clamp(Number(p.default ?? fallback), range[0], range[1]) }
}))
const end = computed(() => kfs.value[kfs.value.length - 1].time)
const speed = computed(() => round(10 ** speedExponent.value, 3))
const speedLabel = computed(() => `${speed.value.toFixed(speed.value < 1 ? 2 : 1)}×`)
const selIdx = computed(() => kfs.value.findIndex((kf) => kf.id === selectedId.value))
const output = computed(() => Object.fromEntries(params.value.map((p) => [p.id, manualValues.value[p.id] ?? valueAt(p, t.value)])))
const trackWidth = computed(() => Math.max(x(end.value) + TRACK_END_PX, viewWidth.value))
const ticks = computed(() => {
    const step = TICK_STEPS.find((s) => s * pxPerSecond.value >= 60) || TICK_STEPS[TICK_STEPS.length - 1]
    const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0
    const list = []
    for (let k = 0; x(k * step) <= trackWidth.value; k++) {
        const time = round(k * step, 3)
        list.push({ t: time, x: x(time), label: time.toFixed(decimals) })
    }
    return list
})

const x = (time) => PAD + time * pxPerSecond.value
const laneHeightPx = computed(() => {
    if (!props.fillHeight) return props.laneHeight
    const scrollbar = scroll.value ? scroll.value.offsetHeight - scroll.value.clientHeight : 0
    const free = bodyHeight.value - RULER_H - MAIN_H - TRACK_BOTTOM - scrollbar - params.value.length * props.laneGap
    return Math.max(props.minLaneHeight, Math.floor(free / params.value.length))
})
const sizes = computed(() => ({
    '--tl-lane-height': laneHeightPx.value + 'px',
    '--tl-lane-gap': props.laneGap + 'px',
    '--tl-ruler-height': RULER_H + 'px',
    '--tl-main-height': MAIN_H + 'px',
}))
const y = (p, value) => laneHeightPx.value - ((value - p.range[0]) / (p.range[1] - p.range[0])) * laneHeightPx.value
const fmt = (value) => (Math.abs(value) < 0.005 ? 0 : value).toFixed(2)
const isEdge = (idx) => idx === 0 || idx === kfs.value.length - 1
const isDragging = (kf, p) => drag.value?.kfId === kf.id && drag.value.paramId === p.id
const isEditing = (kind, kf, p) => editing.value?.kind === kind && editing.value.kfId === kf.id && (!p || editing.value.paramId === p.id)

function timeAt(event) {
    const rect = track.value.getBoundingClientRect()
    return clamp((event.clientX - rect.left - PAD) / pxPerSecond.value, 0, end.value)
}

// ---- values ----

function valueAt(p, time) {
    return timelineValueAt(kfs.value, p.id, time, p.default)
}

function curves(p) {
    const points = kfs.value.filter((kf) => has(kf, p.id))
    const segments = []
    for (let i = 0; i < points.length - 1; i++) {
        const x0 = x(points[i].time), y0 = y(p, points[i].values[p.id])
        const x1 = x(points[i + 1].time), y1 = y(p, points[i + 1].values[p.id])
        const w = x1 - x0, h = y1 - y0
        const d = `M ${x0} ${y0} C ${x0 + EASE[0] * w} ${y0 + EASE[1] * h}, ${x0 + EASE[2] * w} ${y0 + EASE[3] * h}, ${x1} ${y1}`
        segments.push({ key: points[i].id, d })
    }
    return segments
}

// ---- keyframe data ----

function loadKeyframes(list) {
    const loaded = (Array.isArray(list) ? list : [])
        .map((kf) => ({ id: nextKeyframeId++, time: Math.max(0, Number(kf.time) || 0), values: { ...kf.values } }))
        .sort((a, b) => a.time - b.time)
    if (loaded.length === 0) loaded.push({ id: nextKeyframeId++, time: 0, values: {} })
    if (loaded.length === 1) loaded.push({ id: nextKeyframeId++, time: 0, values: {} })
    loaded[0].time = 0
    const last = loaded[loaded.length - 1]
    kfs.value = loaded
    manualValues.value = {}
    if (selIdx.value < 0) selectedId.value = null
    applyDuration(last.time > 0 ? last.time : props.duration ?? 10)
    normalize()
    commit()
}

// The last keyframe sits at the total time, which stays after every keyframe in between.
function applyDuration(value) {
    const list = kfs.value
    const min = (list.length > 2 ? list[list.length - 2].time : 0) + MIN_GAP
    list[list.length - 1].time = round(Math.max(Number(value) || 0, min), 2)
    if (t.value > end.value) t.value = end.value
    if (end.value !== props.duration) emit('update:duration', end.value)
}

function setDuration(value) {
    applyDuration(value)
    commit()
}

function setKeyframeTime(idx, value) {
    if (idx <= 0) return
    if (idx === kfs.value.length - 1) return setDuration(value)
    const kf = kfs.value[idx]
    const time = round(clamp(value, MIN_GAP, end.value - MIN_GAP), 2)
    if (kfs.value.some((other) => other !== kf && Math.abs(other.time - time) < MIN_GAP)) return
    kf.time = time
    kfs.value.sort((a, b) => a.time - b.time)
    if (kf.id === selectedId.value) t.value = time
    commit()
}

// Drop unknown parameters, clamp values, and fill the first and last keyframe completely.
function normalize() {
    const ids = new Set(params.value.map((p) => p.id))
    for (const kf of kfs.value) {
        for (const id of Object.keys(kf.values)) if (!ids.has(id)) delete kf.values[id]
        for (const p of params.value) if (has(kf, p.id)) kf.values[p.id] = clamp(Number(kf.values[p.id]) || 0, p.range[0], p.range[1])
    }
    for (const kf of [kfs.value[0], kfs.value[kfs.value.length - 1]]) {
        for (const p of params.value) if (!has(kf, p.id)) kf.values[p.id] = round(valueAt(p, kf.time), 3)
    }
    if (t.value > end.value) t.value = end.value
}

function commit() {
    const out = kfs.value.map((kf) => ({ time: kf.time, values: { ...kf.values } }))
    const json = JSON.stringify(out)
    if (json === lastEmitted) return
    lastEmitted = json
    emit('update:keyframes', out)
}

// The playhead goes along, so the sliders and the output show the keyframe, and the sliders edit it.
function selectKeyframe(kf) {
    selectedId.value = kf.id
    manualValues.value = {}
    if (!playing.value) t.value = kf.time
}

function addKeyframe(time) {
    time = round(time, 2)
    const near = kfs.value.find((kf) => Math.abs(kf.time - time) < MIN_GAP)
    if (near) {
        selectKeyframe(near)
        return near
    }
    if (time <= 0 || time >= end.value) return
    kfs.value.splice(kfs.value.findIndex((other) => other.time > time), 0, { id: nextKeyframeId++, time, values: {} })
    const kf = kfs.value.find((other) => other.time === time)
    selectKeyframe(kf)
    commit()
    return kf
}

function sliderInput(p, event) {
    const value = Number(event.target.value)
    const kf = kfs.value[selIdx.value]
    if (!kf) {
        manualValues.value = { ...manualValues.value, [p.id]: value }
        return
    }
    t.value = kf.time
    kf.values[p.id] = value
    commit()
}

function sliderReset(p) {
    const { [p.id]: removed, ...others } = manualValues.value
    manualValues.value = others
}

function addKeyframeFromSliders() {
    const values = manualValues.value
    const kf = addKeyframe(t.value)
    if (!kf) return
    Object.assign(kf.values, values)
    commit()
}

function removeKeyframe(idx) {
    if (idx <= 0 || idx >= kfs.value.length - 1) return
    kfs.value.splice(idx, 1)
    selectedId.value = null
    commit()
}

function toggleParam(idx, p) {
    if (idx < 0 || isEdge(idx)) return
    const kf = kfs.value[idx]
    if (has(kf, p.id)) delete kf.values[p.id]
    else kf.values[p.id] = round(valueAt(p, kf.time), 3)
    commit()
}

// Double-click in a lane: put a point there, on the keyframe under the cursor or a new one.
function laneDblClick(event, p) {
    if (event.target.closest('.tl-point, .tl-edit')) return
    const time = timeAt(event)
    const lane = event.currentTarget.getBoundingClientRect()
    const value = round(clamp(p.range[1] - ((event.clientY - lane.top) / laneHeightPx.value) * (p.range[1] - p.range[0]), p.range[0], p.range[1]), 3)
    let kf = kfs.value.find((other) => Math.abs(x(other.time) - x(time)) <= SNAP_PX)
    if (!kf) kf = addKeyframe(time)
    if (!kf) return
    kf.values[p.id] = value
    selectKeyframe(kf)
    commit()
}

function totalChange(event) {
    setDuration(Number(event.target.value))
    event.target.value = end.value
}

// The stretch that repeats. Loop points that make no sense (start after end) count as not set.
const loopRange = computed(() => {
    const start = props.loopStart ?? 0
    const finish = Math.min(props.loopEnd ?? end.value, end.value)
    return start < finish ? { start, finish } : { start: 0, finish: end.value }
})
const showLoopLine = (time) => time !== null && time <= end.value

// Empty clears the loop point; a time that would put the start after the end is refused.
function loopPointChange(event, name) {
    const text = event.target.value.trim()
    const value = text === '' ? null : round(clamp(Number(text), 0, end.value), 2)
    const points = { loopStart: props.loopStart, loopEnd: props.loopEnd, [name]: value }
    if ((points.loopStart ?? 0) >= (points.loopEnd ?? end.value)) {
        event.target.value = props[name] ?? ''
        return
    }
    event.target.value = value ?? ''
    emit(`update:${name}`, value)
}

// ---- dragging ----

function startDrag(onMove, onEnd) {
    stopDrag?.()
    root.value.focus({ preventScroll: true })
    const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        stopDrag = null
        onEnd?.()
    }
    // no button down: the release happened somewhere we didn't see (outside the window)
    const move = (e) => (e.buttons === 0 ? up() : onMove(e))
    stopDrag = up
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
}

function scrubStart(event) {
    t.value = timeAt(event)
    startDrag((e) => (t.value = timeAt(e)))
}

// Keeps the distance to where the handle was grabbed, so grabbing it off-centre doesn't move the playhead.
function playheadDragStart(event) {
    const grabOffset = timeAt(event) - t.value
    startDrag((e) => (t.value = clamp(timeAt(e) - grabOffset, 0, end.value)))
}

function frameDragStart(event, idx) {
    const kf = kfs.value[idx]
    selectKeyframe(kf)
    if (isEdge(idx)) return
    const startX = event.clientX, startTime = kf.time
    const toStep = (time, snap) => round(snap(time / KEYFRAME_DRAG_STEP) * KEYFRAME_DRAG_STEP, 2)
    const isFree = (time) => !kfs.value.some((other) => other.id !== kf.id && Math.abs(other.time - time) < MIN_GAP)
    startDrag((e) => {
        const min = toStep(MIN_GAP, Math.ceil)
        const max = toStep(end.value - MIN_GAP, Math.floor)
        let time = clamp(toStep(startTime + (e.clientX - startX) / pxPerSecond.value, Math.round), min, max)
        const direction = Math.sign(time - kf.time) || 1
        while (!isFree(time) && time >= min && time <= max) time = round(time + direction * KEYFRAME_DRAG_STEP, 2)
        if (time < min || time > max || time === kf.time) return // no free step that way: stay
        kf.time = time
        kfs.value.sort((a, b) => a.time - b.time)
        if (!playing.value) t.value = time
        commit()
    })
}

function pointDragStart(event, idx, p) {
    const kf = kfs.value[idx]
    selectKeyframe(kf)
    drag.value = { kfId: kf.id, paramId: p.id }
    const startY = event.clientY, startValue = kf.values[p.id]
    startDrag((e) => {
        const value = startValue - ((e.clientY - startY) / laneHeightPx.value) * (p.range[1] - p.range[0])
        kf.values[p.id] = round(clamp(value, p.range[0], p.range[1]), 3)
        commit()
    }, () => (drag.value = null))
}

// ---- typing an exact time or value ----

function startEdit(edit) {
    editing.value = edit
    nextTick(() => {
        const input = root.value.querySelector('.tl-edit input')
        input?.focus()
        input?.select()
    })
}

function editTime(idx) {
    if (idx > 0) startEdit({ kind: 'time', kfId: kfs.value[idx].id, text: String(kfs.value[idx].time) })
}

function editValue(kf, p) {
    startEdit({ kind: 'value', kfId: kf.id, paramId: p.id, text: String(kf.values[p.id]) })
}

function editKey(event) {
    if (event.key === 'Enter') commitEdit()
    else if (event.key === 'Escape') editing.value = null
}

function commitEdit() {
    const edit = editing.value
    if (!edit) return
    editing.value = null
    const value = parseFloat(edit.text.replace(',', '.'))
    const idx = kfs.value.findIndex((kf) => kf.id === edit.kfId)
    if (!Number.isFinite(value) || idx < 0) return
    if (edit.kind === 'time') return setKeyframeTime(idx, value)
    const p = params.value.find((other) => other.id === edit.paramId)
    const kf = kfs.value[idx]
    if (!p || !has(kf, p.id)) return
    kf.values[p.id] = round(clamp(value, p.range[0], p.range[1]), 3)
    commit()
}

function removePoint(idx, p) {
    editing.value = null
    toggleParam(idx, p)
}

// ---- playback ----

function play() {
    if (playing.value) return
    if (t.value >= end.value) t.value = 0
    selectedId.value = null
    playing.value = true
    let last = performance.now()
    const tick = (now) => {
        if (!playing.value) return
        let time = t.value + ((now - last) / 1000) * speed.value
        last = now
        const { start, finish } = loopRange.value
        const reachedLoopEnd = looping.value && t.value < finish && time >= finish
        if (reachedLoopEnd || time >= end.value) {
            if (looping.value) {
                const jumpFrom = reachedLoopEnd ? finish : end.value
                time = start + (time - jumpFrom) % (finish - start)
            } else {
                t.value = end.value
                playing.value = false
                return
            }
        }
        t.value = time
        followPlayhead()
        raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
}

function pause() {
    playing.value = false
    cancelAnimationFrame(raf)
}

function togglePlay() {
    if (playing.value) pause()
    else play()
}

function reset() {
    t.value = 0
    manualValues.value = {}
    scroll.value.scrollLeft = 0
}

function seek(time) {
    t.value = clamp(time, 0, end.value)
}

function followPlayhead() {
    const el = scroll.value
    const px = x(t.value)
    if (px > el.scrollLeft + el.clientWidth - 20 || px < el.scrollLeft) el.scrollLeft = px - 40
}

// ---- zoom ----

function zoomBy(factor) {
    const el = scroll.value
    const onScreen = x(t.value) - el.scrollLeft
    pxPerSecond.value = clamp(pxPerSecond.value * factor, ...ZOOM_RANGE)
    nextTick(() => (el.scrollLeft = x(t.value) - onScreen))
}

function fit() {
    pxPerSecond.value = clamp((scroll.value.clientWidth - PAD - TRACK_END_PX) / end.value, ...ZOOM_RANGE)
}

function onKey(event) {
    if (event.target.matches('input[type=text], input[type=number], textarea, select')) return
    if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        removeKeyframe(selIdx.value)
    } else if (event.key === 'Escape') {
        selectedId.value = null
    }
}

// ---- syncing with the parent ----

watch(() => props.keyframes, (value) => {
    if (JSON.stringify(value) !== lastEmitted) loadKeyframes(value)
}, { deep: true })
watch(() => props.parameters, () => {
    normalize()
    commit()
}, { deep: true })
watch(() => props.duration, (value) => {
    if (value != null && value !== end.value) setDuration(value)
})
watch(() => props.time, (value) => {
    if (value !== t.value) t.value = clamp(value, 0, end.value)
})
watch(t, (value) => {
    manualValues.value = {}
    if (!playing.value && kfs.value[selIdx.value]?.time !== value) selectedId.value = null
    emit('update:time', value)
})
watch(output, (values) => emit('output', values))
watch(() => props.zoom, (value) => {
    if (value) pxPerSecond.value = value
})
watch(() => props.loop, (value) => (looping.value = value))
watch(looping, (value) => emit('update:loop', value))
watch(() => props.speed, (value) => {
    if (value !== speed.value) speedExponent.value = speedToExponent(value)
})
watch(speed, (value) => emit('update:speed', value))

loadKeyframes(props.keyframes)
t.value = clamp(props.time, 0, end.value)

onMounted(() => {
    const el = scroll.value
    viewWidth.value = el.clientWidth
    resizeObserver = new ResizeObserver(() => {
        viewWidth.value = el.clientWidth
        bodyHeight.value = body.value.clientHeight
    })
    resizeObserver.observe(el)
    resizeObserver.observe(body.value)
    if (!props.zoom) fit()
    emit('output', output.value)
})

onBeforeUnmount(() => {
    pause()
    resizeObserver.disconnect()
    stopDrag?.()
})

defineExpose({ play, pause, seek, addKeyframe, addKeyframeFromSliders, removeKeyframe })
</script>

<style>
.tl {
    --tl-text: rgba(0, 0, 0, 0.7);
    --tl-muted: rgba(0, 0, 0, 0.4);
    --tl-main-bg: #DDD;
    --tl-lane-bg: #EEE;
    --tl-frame: #34495e;
    --tl-frame-line: #7f8c8d;
    --tl-point: #34495e;
    --tl-curve: #bdc3c7;
    --tl-hover: #e67e22;
    --tl-selected: #2980b9;
    --tl-playhead: #e74c3c;
    font-family: sans-serif;
    font-size: 18px;
    color: var(--tl-text);
    user-select: none;
    -webkit-user-select: none;
    outline: none;
}
.tl { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; }
.tl-body { display: flex; flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.tl-labels { flex: 0 0 190px; min-width: 0; font-size: 13px; }
.tl-label { display: flex; align-items: center; gap: 6px; padding-right: 10px; box-sizing: border-box; }
.tl-label-ruler { height: var(--tl-ruler-height); font-variant-numeric: tabular-nums; color: var(--tl-playhead); }
.tl-label-main { height: var(--tl-main-height); color: var(--tl-muted); }
.tl-label-lane { height: var(--tl-lane-height, 50px); margin-top: var(--tl-lane-gap, 18px); }
.tl-label input { margin: 0; accent-color: var(--tl-selected); }
.tl-label input.hidden { visibility: hidden; }
.tl-name { flex: 0 0 26px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.tl-scroll { flex: 1 1 auto; overflow-x: auto; overflow-y: hidden; }
.tl-track { position: relative; min-width: 100%; padding-bottom: 10px; }

.tl-ruler { position: relative; height: var(--tl-ruler-height); cursor: pointer; font-size: 11px; color: var(--tl-muted); }
.tl-tick { position: absolute; bottom: 0; height: 5px; border-left: 1px solid var(--tl-curve); }
.tl-tick span { position: absolute; left: 3px; bottom: 2px; line-height: 12px; }
.tl-playhead-handle { position: absolute; top: 6px; bottom: 0; width: 14px; margin-left: -7px; border-radius: 4px; background: var(--tl-playhead); cursor: ew-resize; }

.tl-main { position: relative; height: var(--tl-main-height); background-color: var(--tl-main-bg); }
.tl-lane { position: relative; margin-top: var(--tl-lane-gap, 18px); height: var(--tl-lane-height, 50px); background-color: var(--tl-lane-bg); }

.tl-frame { position: absolute; top: 0; width: 0; height: 100%; }
.tl-main .tl-frame-handle {
    position: absolute; width: 0; height: 100%; left: -5px; z-index: 2;
    border-left: 5px solid var(--tl-frame); border-right: 5px solid var(--tl-frame);
    cursor: pointer;
}
.tl-main .tl-frame.selected:not(.fixed) .tl-frame-handle { cursor: ew-resize; }
.tl-main .tl-frame:not(.fixed) .tl-frame-handle:hover { border-color: var(--tl-hover); }
.tl-main .tl-frame.selected .tl-frame-handle { border-color: var(--tl-selected); }

.tl-lane .tl-frame { margin-left: -1px; border-left: 1px solid var(--tl-frame-line); border-right: 1px solid var(--tl-frame-line); pointer-events: none; }
.tl-lane .tl-frame.ghost { border-left: 1px dashed var(--tl-selected); border-right: none; margin-left: 0; }
.tl-point {
    position: absolute; width: 14px; height: 14px; left: -7px; margin-top: -7px; border-radius: 7px;
    background-color: var(--tl-point); cursor: ns-resize; pointer-events: auto; z-index: 2;
}
.tl-point:hover, .tl-point.active { background-color: var(--tl-hover); }
.tl-frame.ghost .tl-point { left: -8px; box-sizing: border-box; background-color: transparent; border: 2px dashed var(--tl-selected); cursor: pointer; }
.tl-frame.ghost .tl-point:hover { background-color: var(--tl-selected); }
.tl-edit { position: absolute; z-index: 10; display: flex; align-items: center; gap: 3px; font-size: 12px; white-space: nowrap; pointer-events: auto; }
.tl-main .tl-edit { left: 10px; top: 50%; transform: translateY(-50%); }
.tl-lane .tl-edit { left: 12px; margin-top: -11px; }
.tl-edit input { width: 48px; font: inherit; padding: 2px 4px; border: 1px solid var(--tl-selected); border-radius: 3px; outline: none; }
.tl-edit button { font: inherit; line-height: 16px; padding: 2px 6px; cursor: pointer; }
.tl-drag-value { position: absolute; left: 12px; margin-top: -8px; font-size: 11px; line-height: 16px; padding: 0 4px; background: #fff; border-radius: 3px; z-index: 3; }

.tl-zero { position: absolute; left: 0; right: 0; border-top: 1px dotted var(--tl-curve); pointer-events: none; }
.tl-curves { position: absolute; top: 0; left: 0; overflow: visible; pointer-events: none; }
.tl-curves path { fill: none; stroke: var(--tl-curve); stroke-width: 1; pointer-events: stroke; cursor: pointer; }
.tl-curves path:hover { stroke: var(--tl-hover); }

/* in front of the lanes, behind the keyframe handles and points */
.tl-loop-line { position: absolute; top: 0; bottom: 0; width: 0; z-index: 1; border-left: 1px solid var(--tl-selected); pointer-events: none; }
.tl-playhead {
    position: absolute; top: var(--tl-ruler-height); bottom: 0; width: 0; margin-left: -1px; z-index: 1; pointer-events: none;
    border-left: 1px dashed var(--tl-playhead); border-right: 1px dashed var(--tl-playhead);
}

.tl-controls { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 0 0 8px 190px; font-size: 13px; }
.tl-gap { width: 8px; }
.tl-check { display: inline-flex; align-items: center; gap: 4px; margin-left: 4px; }
.tl-time { width: 40px; box-sizing: border-box; font: inherit; appearance: textfield; }
.tl-time::-webkit-inner-spin-button, .tl-time::-webkit-outer-spin-button { appearance: none; margin: 0; }
.tl-speed { margin-right: 4px; }
.tl-speed .tl-slider { flex: none; width: 70px; }
.tl-speed-value { width: 36px; font-variant-numeric: tabular-nums; }
.tl-slider { position: relative; display: flex; flex: 1 1 auto; min-width: 0; --tl-thumb: var(--tl-text); }
.tl-slider-moved { --tl-thumb: var(--tl-hover); }
.tl-slider-keyframe { --tl-thumb: var(--tl-selected); }
.tl-slider-centered:before { content: ""; position: absolute; top: 50%; left: 50%; width: 1px; height: 8px; background: var(--tl-muted); transform: translate(-50%, -50%); }
.tl-slider input { position: relative; flex: 1; min-width: 0; height: 2px; margin: 8px 0; border-radius: 2px; background: var(--tl-curve); outline: none; cursor: pointer; appearance: none; }
.tl-slider input:disabled { cursor: default; }
.tl-slider input::-webkit-slider-thumb { width: 11px; height: 11px; border-radius: 50%; background: var(--tl-thumb); appearance: none; }
.tl-slider input::-moz-range-thumb { width: 11px; height: 11px; border: none; border-radius: 50%; background: var(--tl-thumb); }
.tl-icon-button { display: inline-flex; align-items: center; justify-content: center; }
.tl-controls-end { margin-left: auto; }
</style>
