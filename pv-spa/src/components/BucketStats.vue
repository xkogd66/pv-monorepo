<template>
  <div :class="noBorder ? 'px-2 py-3' : 'max-w-md mx-auto px-4 py-4'">
    <div v-if="loading" class="text-center py-3">
      <div class="animate-spin rounded-full h-5 w-5 border-2 border-emerald-500 border-t-transparent mx-auto mb-2"></div>
      <p class="text-gray-500 text-sm md:text-lg">Loading...</p>
    </div>

    <div v-else-if="error" class="py-2 text-red-600 text-sm md:text-lg text-center">
      <p class="mb-1"><i class="fas fa-exclamation-triangle"></i> {{ error }}</p>
      <button class="px-3 py-1 bg-red-100 text-red-700 rounded hover:bg-red-200" @click="fetchStats">Retry</button>
    </div>

    <div v-else class="space-y-3">
      <div class="grid grid-cols-2 gap-3">
        <div v-for="tile in tiles" :key="tile.label" class="px-4 py-3 rounded-lg bg-gray-50 border border-gray-100 text-center">
          <div class="text-lg md:text-xl font-semibold text-gray-900 tabular-nums">{{ tile.value }}</div>
          <div class="text-xs md:text-sm text-gray-500">{{ tile.label }}</div>
        </div>
      </div>

      <div v-if="countryRows.length" class="px-1">
        <div class="text-xs font-medium text-gray-500 mb-1.5">Photos by Country</div>
        <div class="space-y-1 max-h-40 overflow-y-auto">
          <div v-for="row in countryRows" :key="row.country" class="flex items-center justify-between text-sm text-gray-700">
            <span class="truncate">{{ row.country }}</span>
            <span class="font-semibold tabular-nums pl-2">{{ row.count.toLocaleString() }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>


<script setup>
import { ref, computed, onMounted } from 'vue'
const props = defineProps({ noBorder: Boolean })
import apiService from '../services/api.js'

const loading = ref(true)
const error = ref(null)
const stats = ref({})

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
}

const tiles = computed(() => [
  { label: 'Total Photos', value: (stats.value.totalPhotos ?? 0).toLocaleString() },
  { label: 'Total Videos', value: (stats.value.totalVideos ?? 0).toLocaleString() },
  { label: 'Total Albums', value: (stats.value.totalAlbums ?? 0).toLocaleString() },
  { label: 'Gallery Size', value: formatSize(stats.value.totalSize ?? 0) },
])

const countryRows = computed(() => {
  const counts = stats.value.photosByCountry || {}
  return Object.entries(counts)
    .map(([country, count]) => ({ country, count }))
    .sort((a, b) => b.count - a.count)
})

async function fetchStats() {
  loading.value = true
  error.value = null
  try {
    const result = await apiService.request('/stats')
    stats.value = result
  } catch (err) {
    error.value = err.message || 'Failed to fetch bucket statistics.'
  } finally {
    loading.value = false
  }
}

onMounted(fetchStats)
</script>

