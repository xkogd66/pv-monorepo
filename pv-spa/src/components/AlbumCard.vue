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
        <span class="text-xs text-gray-400">No photos yet</span>
      </div>
      <div v-else class="w-full h-full flex items-center justify-center text-gray-300">
        <i class="fas fa-images text-3xl"></i>
      </div>

      <!-- Hover Action Buttons -->
      <div class="absolute top-2.5 right-2.5 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200 z-10">
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
    <h3 class="mt-2.5 text-sm font-semibold text-gray-900 truncate" :title="displayName">{{ displayName }}</h3>
    <p class="mt-0.5 text-xs text-gray-500 tabular-nums">{{ metaLine }}</p>
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

defineEmits(['click', 'rename', 'delete'])

const coverFailed = ref(false)

const displayName = computed(() => {
  return props.album.name.replace(/\.+/g, ' ')
})

const isEmpty = computed(() => !(props.album.fileCount || 0))

const metaLine = computed(() => {
  const count = props.album.fileCount || 0
  const parts = [count === 0 ? 'Empty' : `${count} ${count === 1 ? 'photo' : 'photos'}`]
  if (props.album.year) parts.push(String(props.album.year))
  return parts.join(' · ')
})
</script>
