<!-- AlbumCard.vue -->
<template>
  <div class="group cursor-pointer" @click="$emit('click', album)">
    <!-- Cover -->
    <div class="relative aspect-[4/3] rounded-lg overflow-hidden bg-gray-100">
      <img
        v-if="album.coverThumbnailUrl && !coverFailed"
        :src="album.coverThumbnailUrl"
        :alt="displayName"
        loading="lazy"
        class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
        @error="coverFailed = true"
      />
      <div
        v-else-if="isEmpty"
        class="w-full h-full flex items-center justify-center rounded-lg border border-dashed border-gray-300"
      >
        <span class="text-[11px] sm:text-xs text-gray-400">No photos yet</span>
      </div>
      <div v-else class="w-full h-full flex items-center justify-center text-gray-300">
        <i class="fas fa-images text-3xl"></i>
      </div>

      <!-- Hover actions (pointer devices only — there is no hover on touch) -->
      <div class="hidden md:flex absolute top-2.5 right-2.5 gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200 z-10">
        <button
          v-if="canRename"
          @click.stop="$emit('rename', album)"
          title="Edit Album"
          class="w-7 h-7 bg-white/95 backdrop-blur-sm text-gray-700 rounded-full shadow-sm hover:bg-blue-500 hover:text-white transition-all flex items-center justify-center"
        >
          <i class="fas fa-edit text-xs"></i>
        </button>
        <button
          v-if="canDelete"
          @click.stop="$emit('delete', album)"
          title="Delete Album"
          class="w-7 h-7 bg-white/95 backdrop-blur-sm text-gray-700 rounded-full shadow-sm hover:bg-red-500 hover:text-white transition-all flex items-center justify-center"
        >
          <i class="fas fa-trash text-xs"></i>
        </button>
      </div>
    </div>

    <!-- Caption -->
    <div class="flex items-start gap-1 mt-2.5">
      <div class="min-w-0 flex-1">
        <h3 class="text-[13px] sm:text-sm font-semibold text-gray-900 truncate" :title="displayName">{{ displayName }}</h3>
        <p class="mt-0.5 text-[11px] sm:text-xs text-gray-500 tabular-nums">{{ metaLine }}</p>
      </div>
      <!-- Touch equivalent of the hover actions -->
      <button
        v-if="hasActions"
        @click.stop="showSheet = true"
        aria-label="Album actions"
        class="md:hidden flex-none -mt-2 -mr-2 w-8 h-11 flex items-start justify-center pt-1 text-gray-400"
      >
        <i class="fas fa-ellipsis-v"></i>
      </button>
    </div>

    <!-- Action sheet (touch) -->
    <Teleport to="body">
      <div v-if="showSheet" class="md:hidden fixed inset-0 z-50" @click="showSheet = false">
        <div class="absolute inset-0 bg-gray-900/40"></div>
        <div class="absolute inset-x-0 bottom-0 bg-white rounded-t-2xl pb-5 shadow-2xl" @click.stop>
          <div class="flex justify-center pt-2.5 pb-1.5">
            <div class="w-9 h-1 rounded-full bg-gray-200"></div>
          </div>
          <div class="px-5 pt-1.5 pb-3.5 border-b border-gray-100">
            <div class="text-[15px] font-semibold text-gray-900 truncate">{{ displayName }}</div>
            <div class="mt-0.5 text-xs text-gray-500 tabular-nums">{{ metaLine }}</div>
          </div>
          <button
            v-if="canRename"
            @click="runAction('rename')"
            class="flex items-center gap-3.5 w-full h-14 px-5 text-base text-gray-900"
          >
            <i class="fas fa-edit text-gray-600 w-5"></i> Edit album
          </button>
          <button
            v-if="canDelete"
            @click="runAction('delete')"
            class="flex items-center gap-3.5 w-full h-14 px-5 text-base text-red-600"
          >
            <i class="fas fa-trash w-5"></i> Delete album
          </button>
          <div class="h-px bg-gray-100 mx-5 my-1.5"></div>
          <button @click="showSheet = false" class="w-full h-14 px-5 text-base text-gray-600">Cancel</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  album: {
    type: Object,
    required: true
  },
  canRename: {
    type: Boolean,
    default: false
  },
  canDelete: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['click', 'rename', 'delete'])

const coverFailed = ref(false)
const showSheet = ref(false)

const displayName = computed(() => {
  return props.album.name.replace(/\.+/g, ' ')
})

const isEmpty = computed(() => !(props.album.fileCount || 0))

const hasActions = computed(() => props.canRename || props.canDelete)

const metaLine = computed(() => {
  const count = props.album.fileCount || 0
  const parts = [count === 0 ? 'Empty' : `${count} ${count === 1 ? 'photo' : 'photos'}`]
  if (props.album.year) parts.push(String(props.album.year))
  return parts.join(' · ')
})

const runAction = (name) => {
  showSheet.value = false
  emit(name, props.album)
}
</script>
