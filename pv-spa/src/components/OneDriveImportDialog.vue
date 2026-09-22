<template>
  <div v-if="visible" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[1000]"
    @click="$emit('close')">
    <div class="bg-white rounded-xl p-6 w-full max-w-md shadow-xl mx-4" @click.stop>
      <h3 class="text-lg font-semibold text-gray-800 mb-4">Import from OneDrive</h3>

      <p v-if="started" class="text-sm text-gray-700 mb-6">
        Import of <strong>{{ albumName }}</strong> started. Follow it on the Monitor page.
      </p>

      <template v-else>
        <!-- Breadcrumb: photo-albums / 2023 / ... -->
        <div class="text-sm text-gray-600 mb-2 flex flex-wrap gap-1">
          <button class="hover:underline" @click="open(0)">photo-albums</button>
          <template v-for="(seg, i) in segments" :key="i">
            <span>/</span>
            <button class="hover:underline" @click="open(i + 1)">{{ seg }}</button>
          </template>
        </div>

        <div class="border border-gray-200 rounded-md h-56 overflow-y-auto mb-4">
          <p v-if="loading" class="p-3 text-sm text-gray-500">Loading...</p>
          <p v-else-if="!folders.length" class="p-3 text-sm text-gray-500">No subfolders</p>
          <button v-for="f in folders" :key="f" @click="enter(f)"
            class="w-full text-left px-3 py-2 min-h-[44px] text-sm hover:bg-gray-50 flex items-center gap-2">
            <i class="fas fa-folder text-amber-400"></i>{{ f }}
          </button>
        </div>

        <template v-if="segments.length">
          <label class="block mb-1 text-sm font-medium text-gray-800">Album name</label>
          <input v-model="albumName" type="text"
            class="w-full px-3 py-2 mb-3 border border-gray-300 rounded-md focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200" />
          <div class="flex gap-3 mb-4">
            <input v-model="month" type="number" min="1" max="12" placeholder="Month"
              class="w-1/2 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:border-emerald-500" />
            <input v-model="year" type="number" min="1900" max="2100" placeholder="Year"
              class="w-1/2 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:border-emerald-500" />
          </div>
        </template>

        <p v-if="error" class="text-sm text-red-600 mb-4">{{ error }}</p>
      </template>

      <div class="flex justify-end gap-3">
        <button @click="$emit('close')"
          class="bg-gray-100 text-gray-800 border border-gray-300 px-4 py-2 min-h-[44px] rounded-md text-sm hover:bg-gray-200">
          {{ started ? 'Close' : 'Cancel' }}
        </button>
        <button v-if="!started" @click="startImport" :disabled="!segments.length || !albumName.trim() || importing"
          class="bg-emerald-500 text-white px-4 py-2 min-h-[44px] rounded-md text-sm font-semibold hover:bg-emerald-600 disabled:opacity-60 disabled:cursor-not-allowed">
          {{ importing ? 'Starting...' : 'Import this folder' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import apiService from '../services/api.js'
import { useUploadMonitor } from '../services/uploadMonitor.js'

const props = defineProps({ visible: { type: Boolean, default: false } })
const emit = defineEmits(['close', 'imported'])
const { registerBulkUpload } = useUploadMonitor()

const segments = ref([])
const folders = ref([])
const loading = ref(false)
const error = ref(null)
const albumName = ref('')
const month = ref('')
const year = ref('')
const importing = ref(false)
const started = ref(false)

const load = async () => {
  loading.value = true
  error.value = null
  try {
    folders.value = (await apiService.listOneDriveFolders(segments.value.join('/'))).folders
  } catch (err) {
    folders.value = []
    error.value = err.message
  } finally {
    loading.value = false
  }
}

// Pre-fill from the folder: "2023/(02) solna" → solna, month 2, year 2023.
// Anything not in that shape just uses the folder name.
const prefill = () => {
  const name = segments.value.at(-1) || ''
  const parent = segments.value.at(-2) || ''
  const m = name.match(/^\((\d{1,2})\)\s*(.+)$/)
  albumName.value = m ? m[2] : name
  month.value = m ? Number(m[1]) : ''
  year.value = /^\d{4}$/.test(parent) ? Number(parent) : ''
}

const open = (depth) => {
  segments.value = segments.value.slice(0, depth)
  prefill()
  load()
}

const enter = (folder) => {
  segments.value = [...segments.value, folder]
  prefill()
  load()
}

const startImport = async () => {
  importing.value = true
  error.value = null
  const name = albumName.value.trim()
  try {
    // Private by default, same as "New album"; 409 if the name is taken.
    await apiService.createFolder(name, null, month.value || null, year.value || null, true)
    const res = await apiService.importFromOneDrive(segments.value.join('/'), name)
    registerBulkUpload({ workflowId: `batch-${res.batchId}`, batchId: res.batchId, albumName: name })
    started.value = true
    emit('imported')
  } catch (err) {
    error.value = err.message
  } finally {
    importing.value = false
  }
}

watch(() => props.visible, (v) => {
  if (!v) return
  started.value = false
  open(0)
})
</script>
