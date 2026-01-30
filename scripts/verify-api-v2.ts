import fetch from 'node-fetch'

const BASE_URL = 'http://localhost:3000/api/v2'

async function runVerification() {
  console.log('Verifying API V2...')

  try {
    // 1. Fetch Root (parentId=null)
    console.log('1. Fetching Root Items (parentId=null)...')
    const rootRes = await fetch(`${BASE_URL}/items?parentId=null`)
    if (!rootRes.ok) throw new Error(`Failed to fetch root: ${rootRes.statusText}`)
    const rootItems = (await rootRes.json()) as any[]
    console.log(`   Found ${rootItems.length} root items.`)

    if (rootItems.length === 0) {
      console.log('   No root items found. Skipping children check.')
      return
    }

    const testRootId = rootItems[0].id
    console.log(`   Using Root ID: ${testRootId}`)

    // 2. Fetch Children with Pagination and Fields
    console.log('2. Fetching Children (limit=2, fields=id,name)...')
    const childRes = await fetch(`${BASE_URL}/items/${testRootId}/children?limit=2&fields=id,name`)
    if (!childRes.ok) throw new Error(`Failed to fetch children: ${childRes.statusText}`)
    const children = (await childRes.json()) as any[]
    console.log(`   Found ${children.length} children.`)

    if (children.length > 0) {
      const child = children[0]
      const keys = Object.keys(child)
      console.log(`   Child Keys: ${keys.join(', ')}`)

      if (keys.includes('overview') || keys.includes('size')) {
        console.error('   ❌ FAIL: Response contains unrequested fields!')
      } else if (keys.includes('id') && keys.includes('name')) {
        console.log('   ✅ PASS: Response contains only requested fields.')
      } else {
        console.warn('   ⚠️ Partial pass: Response keys suspicious.')
      }
    }

    // 3. Fetch Single Item
    console.log('3. Fetching Single Item...')
    const itemRes = await fetch(`${BASE_URL}/items/${testRootId}`)
    if (!itemRes.ok) throw new Error(`Failed to fetch item: ${itemRes.statusText}`)
    const item = await itemRes.json()
    console.log('   ✅ PASS: Fetched single item.')
  } catch (err: any) {
    if (err.code === 'ECONNREFUSED') {
      console.error('❌ FAIL: Connection refused. Is the server running on port 3000?')
      console.error('   Run "pnpm dev" in another terminal.')
    } else {
      console.error('❌ FAIL:', err.message)
    }
  }
}

runVerification()
