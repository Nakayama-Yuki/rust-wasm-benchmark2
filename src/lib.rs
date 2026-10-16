#[no_mangle]
pub extern "C" fn alloc(length: usize) -> *mut u16 {
    let buffer = vec![0_u16; length].into_boxed_slice();
    Box::into_raw(buffer) as *mut u16
}

#[no_mangle]
pub unsafe extern "C" fn dealloc(pointer: *mut u16, length: usize) {
    drop(Box::from_raw(core::ptr::slice_from_raw_parts_mut(pointer, length)));
}

#[no_mangle]
pub unsafe extern "C" fn render(
    pointer: *mut u16,
    width: usize,
    height: usize,
    max_iterations: u32,
) -> u32 {
    let output = core::slice::from_raw_parts_mut(pointer, width * height);
    let mut checksum = 0_u32;

    for py in 0..height {
        let imaginary = (py as f64 / height as f64) * 2.4 - 1.2;
        for px in 0..width {
            let real = (px as f64 / width as f64) * 3.5 - 2.5;
            let mut zr = 0.0_f64;
            let mut zi = 0.0_f64;
            let mut count = 0_u32;

            while zr * zr + zi * zi <= 4.0 && count < max_iterations {
                let next_zr = zr * zr - zi * zi + real;
                zi = 2.0 * zr * zi + imaginary;
                zr = next_zr;
                count += 1;
            }

            let index = py * width + px;
            output[index] = count as u16;
            checksum = checksum.wrapping_add(count);
        }
    }

    checksum
}
